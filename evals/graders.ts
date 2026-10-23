import { validateLineup } from "../src/lineup.js";
import type { Scenario } from "./cases.js";

export type Check = { name: string; pass: boolean; detail: string };

export function grade(scenario: Scenario, output: unknown): Check[] {
  let lineup;
  try {
    const { contest, pool, version } = scenario.context;
    lineup = validateLineup(output, contest, pool, version);
  } catch (error) {
    return [
      {
        name: "legal-lineup",
        pass: false,
        detail: [
          error instanceof Error ? error.message : "Invalid lineup",
          `Expected slots: ${scenario.context.contest.roster_slots.map((s) => s.slot).join(", ")}`,
          `Returned slots: ${output && typeof output === "object" && "players" in output && Array.isArray(output.players) ? output.players.map((p) => p?.slot ?? "(missing)").join(", ") : "(missing players array)"}`,
        ].join(". "),
      },
    ];
  }
  const ids = lineup.players.map((p) => p.player_id);
  return [
    {
      name: "legal-lineup",
      pass: true,
      detail:
        "Schema, slots, eligibility, salary, reasoning length and version accepted.",
    },
    ...scenario.required.map((id) => ({
      name: `select:${id}`,
      pass: ids.includes(id),
      detail: `Expected ${id}; selected ${ids.join(", ")}`,
    })),
    ...scenario.forbidden.map((id) => ({
      name: `avoid:${id}`,
      pass: !ids.includes(id),
      detail: `Must avoid ${id}; selected ${ids.join(", ")}`,
    })),
  ];
}
