import "dotenv/config";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createLineupGenerator } from "../src/agent.js";
import { readConfig } from "../src/config.js";
import { scenarios } from "./cases.js";
import { grade, type Check } from "./graders.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "npm run eval -- [--list | --case ID] [--repeat N]\nPaid: one Claude API call per case per repetition. No web search or MAFL calls.",
    );
    return;
  }
  if (args.length === 1 && args[0] === "--list") {
    for (const s of scenarios) console.log(`${s.id}: ${s.description}`);
    return;
  }
  let caseId: string | undefined;
  let repeat = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--case" && args[i + 1]) caseId = args[++i];
    else if (args[i] === "--repeat" && args[i + 1]) repeat = Number(args[++i]);
    else throw new Error("Unknown or incomplete option; use --help");
  }
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10)
    throw new Error("--repeat must be 1..10");
  const selected = caseId
    ? scenarios.filter((s) => s.id === caseId)
    : scenarios;
  if (!selected.length) throw new Error("Unknown case; use --list");
  // Fix the task across contributors; keep credentials/model/runtime limits local.
  const config = readConfig({
    ...process.env,
    AGENT_PROMPT:
      "Select the strongest legal lineup from the supplied contest, frozen player pool and evidence packet.",
    AGENT_INSTRUCTIONS:
      "Maximize expected fantasy points using the supplied evidence. Distinguish estimates from facts and acknowledge missing information.",
  });
  const generate = createLineupGenerator(config);
  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const directory = `evals/results/${runId}`;
  await mkdir(directory, { recursive: true });
  const agentHash = createHash("sha256")
    .update(await readFile(new URL("../src/agent.ts", import.meta.url)))
    .digest("hex");
  const records = [];
  console.log(
    `Model: ${config.model}. Running ${selected.length * repeat} paid calls sequentially.`,
  );
  for (const scenario of selected)
    for (let trial = 1; trial <= repeat; trial++) {
      console.log(`Running ${scenario.id} (trial ${trial})...`);
      const start = Date.now();
      let output: unknown;
      let usage: unknown;
      let checks: Check[];
      try {
        const result = await generate(
          scenario.context,
          scenario.research,
          AbortSignal.timeout(config.timeoutMs),
        );
        output = result.lineup;
        usage = result.usage;
        checks = grade(scenario, output);
      } catch {
        // Raw SDK errors can contain request bodies. Keep diagnostics safe.
        checks = [
          {
            name: "generation",
            pass: false,
            detail:
              "Generation failed; check credentials, model access, network and token/timeout limits. Raw error omitted.",
          },
        ];
      }
      const pass = checks.every((c) => c.pass);
      const record = {
        caseId: scenario.id,
        trial,
        pass,
        latencyMs: Date.now() - start,
        checks,
        output,
        usage,
        scenario,
      };
      // Custom task text/model output may contain sensitive data. Redact the known key.
      const safeRecord = JSON.parse(
        JSON.stringify(record).replaceAll(config.apiKey, "[REDACTED]"),
      );
      records.push(safeRecord);
      await writeFile(
        `${directory}/${scenario.id}-${trial}.json`,
        JSON.stringify(safeRecord, null, 2) + "\n",
        { mode: 0o600 },
      );
      console.log(
        `${pass ? "PASS" : "FAIL"} ${scenario.id} (${record.latencyMs} ms)`,
      );
      for (const check of checks)
        console.log(
          `  ${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
        );
    }
  const passed = records.filter((r) => r.pass).length;
  const report = {
    runId,
    model: config.model,
    agentHash,
    settings: {
      effort: config.effort ?? "model default",
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      prompt: config.prompt,
      instructions: config.instructions,
    },
    passed,
    total: records.length,
    records,
  };
  await writeFile(
    `${directory}/summary.json`,
    JSON.stringify(report, null, 2).replaceAll(config.apiKey, "[REDACTED]") +
      "\n",
    { mode: 0o600 },
  );
  console.log(
    `\n${passed}/${records.length} trials passed. Full inputs, outputs, checks and usage: ${directory}/summary.json`,
  );
  if (passed !== records.length) process.exitCode = 1;
}
main().catch(() => {
  console.error(
    "Eval setup failed. Check --help, case ID, configuration and output directory permissions. No raw error printed.",
  );
  process.exitCode = 1;
});
