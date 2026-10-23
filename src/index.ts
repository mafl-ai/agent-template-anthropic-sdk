import "dotenv/config";
import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { readConfig } from "./config.js";
import { createAgent } from "./workflow.js";
import { AgentError } from "./errors.js";
import { MaflError } from "./mafl.js";
import { createRunner } from "./runner.js";

function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
  );
}

// Avoid logging raw exceptions, request bodies, headers, or configuration secrets.

function reportFailure(error: unknown) {
  log(
    "run_failed",
    error instanceof Anthropic.APIError
      ? { type: error.name, status: error.status, requestId: error.requestID }
      : error instanceof MaflError
        ? { type: error.name, status: error.status, code: error.code }
        : error instanceof AgentError
          ? { type: error.name, reason: error.message }
          : { type: error instanceof Error ? error.name : "UnknownError" },
  );
}

async function main() {
  const args = process.argv.slice(2);

  if (
    args.some((arg) => !["--once", "--dry-run"].includes(arg)) ||
    new Set(args).size !== args.length ||
    (args.includes("--dry-run") && !args.includes("--once"))
  ) {
    throw new Error("Usage: npm start [-- --once [--dry-run]]");
  }

  const config = readConfig();
  const agent = createAgent(config, { onEvent: log });
  const runner = createRunner((signal) =>
    agent(signal, args.includes("--dry-run")),
  );

  const run = async () => {
    log("run_started");
    try {
      const result = await runner.run();

      if (result) log("run_completed", result);
      else log("run_skipped");
    } catch (error) {
      reportFailure(error);

      if (args.includes("--once")) process.exitCode = 1;
    }
  };

  const tasks = args.includes("--once")
    ? []
    : [
        ...new Set([config.schedule, config.revisionSchedule].filter(Boolean)),
      ].map((schedule) =>
        cron.schedule(schedule, run, {
          timezone: config.timezone,
          noOverlap: true,
        }),
      );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all(tasks.map((task) => task.stop()));
    await runner.stop();
    await Promise.all(tasks.map((task) => task.destroy()));
    log("stopped");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  if (args.includes("--once")) await run();
  else
    log("scheduler_started", {
      schedule: config.schedule,
      revisionSchedule: config.revisionSchedule,
      timezone: config.timezone,
    });
}

main().catch((error) => {
  // Startup errors are locally constructed validation messages.
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
});
