import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";

const env = { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_MODEL: "test-model" };

test("defaults and explicit configuration", () => {
  assert.equal(readConfig(env).schedule, "0 14 * * 2");
  assert.equal(readConfig(env).effort, undefined);
  assert.equal(readConfig({ ...env, AGENT_EFFORT: "" }).effort, undefined);

  const config = readConfig({
    ...env,
    AGENT_TIMEZONE: "America/Los_Angeles",
    AGENT_MAX_OUTPUT_TOKENS: "500",
    AGENT_EFFORT: "xhigh",
  });
  assert.equal(config.timezone, "America/Los_Angeles");
  assert.equal(config.maxOutputTokens, 500);
  assert.equal(config.effort, "xhigh");
});

test("reject invalid configuration without exposing values", () => {
  for (const invalid of [
    { ANTHROPIC_API_KEY: "" },
    { ANTHROPIC_MODEL: "" },
    { AGENT_EFFORT: "extreme" },
    { AGENT_SCHEDULE: "invalid" },
    { AGENT_TIMEZONE: "invalid" },
    { AGENT_TIMEOUT_MS: "0" },
    { AGENT_TIMEOUT_MS: "NaN" },
    { AGENT_MAX_OUTPUT_TOKENS: "1.5" },
    { AGENT_MAX_OUTPUT_TOKENS: "128001" },
  ])
    assert.throws(() => readConfig({ ...env, ...invalid }));
});
