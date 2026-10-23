import { test } from "node:test";
import assert from "node:assert/strict";
import { scenarios } from "../evals/cases.js";
import { grade } from "../evals/graders.js";
import type { Lineup } from "../src/lineup.js";

function candidate(flex: string): Lineup {
  return {
    players: ["qb-steady", flex].map((id, i) => ({
      slot: i === 0 ? "QB" : "FLEX",
      player_id: id,
      rationale: `For this synthetic week, player ${id} provides an estimated workload and salary combination supported by the supplied evidence packet.`,
      confidence: 0.6,
      primary_factor: "value",
    })),
    thesis:
      "This synthetic weekly lineup balances the supplied scoring estimates and salary constraints while acknowledging the uncertainty of individual player performance.",
    projected_score: 35,
    confidence: 0.6,
    skill_version: "1.8",
  };
}

test("eval grader distinguishes legal but wrong decisions from invalid lineups", () => {
  const scenario = scenarios.find((s) => s.id === "confirmed-out")!;
  assert.ok(grade(scenario, candidate("wr-healthy")).every((c) => c.pass));
  const wrong = grade(scenario, candidate("rb-star"));
  assert.equal(wrong[0]!.pass, true);
  assert.equal(wrong.find((c) => c.name === "avoid:rb-star")!.pass, false);
  assert.equal(grade(scenario, { players: [] })[0]!.pass, false);
});

test("each eval case has a feasible passing lineup and rejects its targeted failure", () => {
  for (const scenario of scenarios) {
    assert.ok(
      grade(scenario, candidate(scenario.required[0]!)).every((c) => c.pass),
      scenario.id,
    );
    assert.ok(
      grade(scenario, candidate(scenario.forbidden[0]!)).some((c) => !c.pass),
      scenario.id,
    );
  }
});

test("production generation excludes candidates that cannot fit the remaining salary budget", async () => {
  const { createLineupGenerator } = await import("../src/agent.js");
  const { readConfig } = await import("../src/config.js");
  const scenario = scenarios.find((s) => s.id === "tight-cap")!;
  let guide: {
    slot: string;
    candidates: { player_id: string; salary: number }[];
  }[] = [];
  const client = {
    messages: {
      stream: (request: { messages: { content: string }[] }) => {
        const prefix =
          "Budget guide (computed from salaries, reserving minimum costs for other slots): ";
        const encoded =
          request.messages[0]!.content.split(prefix)[1]!.split(
            ". Select only",
          )[0]!;
        guide = JSON.parse(encoded);
        return {
          finalMessage: async () => ({
            stop_reason: "end_turn",
            content: [
              { type: "text", text: JSON.stringify(candidate("rb-backup")) },
            ],
          }),
        };
      },
    },
  };
  await createLineupGenerator(
    readConfig({
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "test-model",
    }),
    client as unknown as import("@anthropic-ai/sdk").default,
  )(scenario.context, scenario.research, new AbortController().signal);
  assert.deepEqual(guide.find((g) => g.slot === "FLEX")!.candidates, [
    { player_id: "rb-backup", salary: 4000 },
  ]);
  assert.deepEqual(guide.find((g) => g.slot === "QB")!.candidates, [
    { player_id: "qb-steady", salary: 6000 },
  ]);
});
