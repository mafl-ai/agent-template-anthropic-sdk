import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSameRules, parseScoring } from "../src/compatibility.js";
import { parseContest, parsePool, validateLineup } from "../src/lineup.js";
import { contest, pool, scoring, lineup, copy } from "./fixtures.js";

test("scoring validates actual fields and aliases while allowing additive fields", () => {
  assert.ok(parseScoring({ ...scoring, extra: true }, contest));
  assert.ok(
    parseScoring(
      { ...scoring, version: undefined, scoring_version: scoring.version },
      contest,
    ),
  );
  for (const invalid of [
    { ...scoring, scoring_version: "other" },
    { ...scoring, format: "future" },
    { ...scoring, passing: {} },
    { ...scoring, fumble_lost: "-2" },
    { ...scoring, rushing: { ...scoring.rushing, yards_per_point: 0 } },
  ])
    assert.throws(() => parseScoring(invalid, contest));
});

test("contest rule refresh detects semantic changes but ignores ordering and additive fields", () => {
  for (const changes of [
    { salary_cap: 40000 },
    { salary_version: "new" },
    { scoring_version: "new" },
    { lock_time: "2026-10-04T14:00:00Z" },
    { roster_slots: [{ slot: "QB", positions: ["RB"] }] },
  ])
    assert.throws(
      () => assertSameRules(contest, { ...contest, ...changes }),
      /rules changed/,
    );
  const reordered = copy(contest);
  reordered.roster_slots.reverse();
  reordered.roster_slots.forEach((s) => s.positions.reverse());
  assert.doesNotThrow(() => assertSameRules(contest, reordered));
  assert.throws(() => parseContest({ ...contest, status: "future" }));
  const invalidPool = copy(pool);
  invalidPool.players[0]!.kickoff = "invalid";
  assert.throws(() => parsePool(invalidPool, contest));
});

test("initial cap and slot names remain derived from API data", () => {
  const changed = parseContest({
    ...contest,
    salary_cap: 20000,
    roster_slots: [
      { slot: "PASSER", positions: ["QB"] },
      { slot: "RUNNER", positions: ["RB"] },
    ],
    extra: true,
  });
  const body = copy(lineup);
  body.players.forEach((p, i) => (p.slot = changed.roster_slots[i]!.slot));
  assert.doesNotThrow(() =>
    validateLineup(body, changed, parsePool(pool, changed), body.skill_version),
  );
});
