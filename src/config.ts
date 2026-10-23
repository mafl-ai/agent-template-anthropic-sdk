import cron from "node-cron";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  function required(name: string): string {
    const value = env[name]?.trim();

    if (!value) throw new Error(`${name} is required; see .env.example`);

    return value;
  }

  function integer(name: string, fallback: number, max: number): number {
    const value = env[name] === undefined ? fallback : Number(env[name]);

    if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
      throw new Error(`${name} must be an integer between 1 and ${max}`);
    }

    return value;
  }

  const schedule = env.AGENT_SCHEDULE ?? "0 14 * * 2";

  if (!cron.validate(schedule)) throw new Error("AGENT_SCHEDULE is invalid");

  const revisionSchedule = env.AGENT_REVISION_SCHEDULE ?? "0 10 * * 0";

  if (revisionSchedule && !cron.validate(revisionSchedule))
    throw new Error("AGENT_REVISION_SCHEDULE is invalid");

  const timezone = env.AGENT_TIMEZONE ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("AGENT_TIMEZONE must be a valid IANA timezone");
  }

  // Empty or unset leaves effort to the model's own default.
  const effort = env.AGENT_EFFORT?.trim() || undefined;

  if (effort !== undefined && !(efforts as readonly string[]).includes(effort))
    throw new Error(
      `AGENT_EFFORT must be empty or one of ${efforts.join(", ")}`,
    );

  return {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: required("ANTHROPIC_MODEL"),
    schedule,
    timezone,
    revisionSchedule,
    instructions:
      env.AGENT_INSTRUCTIONS ??
      "Prioritize evidence-based weekly NFL fantasy points and honest confidence.",
    prompt:
      env.AGENT_PROMPT ??
      "Research the current MAFL contest and select the strongest legal weekly lineup.",
    effort: effort as (typeof efforts)[number] | undefined,
    maxOutputTokens: integer("AGENT_MAX_OUTPUT_TOKENS", 16000, 128000),
    timeoutMs: integer("AGENT_TIMEOUT_MS", 300000, 600000),
    maxSearchCalls: integer("AGENT_MAX_SEARCH_CALLS", 5, 20),
    maflKey: env.MAFL_API_KEY?.trim(),
    maflKeyFile: env.MAFL_KEY_FILE ?? ".mafl-key",
    stateDir: env.AGENT_STATE_DIR ?? ".mafl-state",
  };
}

export type Config = ReturnType<typeof readConfig>;
