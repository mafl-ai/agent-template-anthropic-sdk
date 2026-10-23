import type { Contest, Pool, Lineup } from "../src/lineup.js";

export const contest: Contest = {
  id: "2026-W04",
  status: "open",
  lock_time: "2026-10-04T13:30:00Z",
  now: "2026-09-30T12:00:00Z",
  seconds_until_lock: 300000,
  salary_cap: 50000,
  scoring_version: "2026.1",
  salary_version: "salary-1",
  roster_slots: [
    { slot: "QB", positions: ["QB"] },
    { slot: "FLEX", positions: ["RB", "WR", "TE"] },
  ],
};

export const pool: Pool = {
  contest_id: contest.id,
  salary_version: contest.salary_version,
  attribution: "nflverse (CC-BY 4.0)",
  players: [
    {
      player_id: "qb-1",
      name: "QB One",
      team: "KC",
      position: "QB",
      opponent: "LAC",
      kickoff: contest.lock_time,
      salary: 7000,
    },
    {
      player_id: "rb-1",
      name: "RB One",
      team: "KC",
      position: "RB",
      opponent: "LAC",
      kickoff: contest.lock_time,
      salary: 6000,
    },
  ],
};

export const lineup: Lineup = {
  players: pool.players.map((p, i) => ({
    slot: contest.roster_slots[i]!.slot,
    player_id: p.player_id,
    rationale: `Player ${i} has a strong projected workload this week based on recent usage reports and favorable matchup evidence.`,
    confidence: 0.6,
    primary_factor: "value",
  })),
  thesis:
    "This balanced lineup prioritizes expected workload and efficient salaries while accounting for uncertainty in this specific weekly slate.",
  projected_score: 70,
  confidence: 0.6,
  skill_version: "1.4",
};

export const recorded = { ...lineup, lineup_id: "lineup-1", revision: 1 };

export const scoring = {
  version: "2026.1",
  format: "ppr",
  passing: {
    yards_per_point: 25,
    touchdown: 4,
    interception: -2,
    two_point_conversion: 2,
  },
  rushing: { yards_per_point: 10, touchdown: 6, two_point_conversion: 2 },
  receiving: {
    reception: 1,
    yards_per_point: 10,
    touchdown: 6,
    two_point_conversion: 2,
  },
  fumble_lost: -2,
};

export const copy = <T>(value: T): T => structuredClone(value);
