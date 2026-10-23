import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLineup } from "../src/lineup.js";
import { contest, pool, lineup, copy } from "./fixtures.js";

test("valid lineup passes while illegal or unsafe outputs fail", () => {
  assert.deepEqual(validateLineup(lineup, contest, pool, "1.4"), lineup);

  const mutations: ((v: typeof lineup) => void)[] = [
    (v) => {
      v.players[1]!.player_id = "qb-1";
    },
    (v) => {
      v.players[0]!.slot = "UNKNOWN";
    },
    (v) => {
      v.players.pop();
    },
    (v) => {
      v.players[0]!.player_id = "absent";
    },
    (v) => {
      v.confidence = 2;
    },
    (v) => {
      v.projected_score = -1;
    },
    (v) => {
      v.thesis = "short";
    },
    (v) => {
      v.players[1]!.rationale = v.players[0]!.rationale;
    },
    (v) => {
      v.skill_version = "old";
    },
    (v) => {
      Object.assign(v, { salary: 100 });
    },
  ];

  for (const mutate of mutations) {
    const v = copy(lineup);
    mutate(v);
    assert.throws(() => validateLineup(v, contest, pool, "1.4"));
  }
  assert.throws(
    () => validateLineup(lineup, { ...contest, salary_cap: 100 }, pool, "1.4"),
    /salary cap/,
  );
  assert.throws(
    () => validateLineup(lineup, contest, pool, "1.4", ["balanced lineup"]),
    /Credential/,
  );
});
