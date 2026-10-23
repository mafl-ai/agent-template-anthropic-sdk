import { AgentError } from "./errors.js";

export type Contest = {
  id: string;
  status: string;
  lock_time: string;
  now: string;
  seconds_until_lock: number;
  salary_cap: number;
  roster_slots: { slot: string; positions: string[] }[];
  scoring_version: string;
  salary_version: string;
};

export type Player = {
  player_id: string;
  name: string;
  team: string;
  position: string;
  opponent: string;
  kickoff: string;
  salary: number;
};

export type Pool = {
  contest_id: string;
  salary_version: string;
  attribution: string;
  players: Player[];
};

export const factors = [
  "matchup",
  "injury",
  "value",
  "gut",
  "contrarian",
] as const;

export type Lineup = {
  players: {
    slot: string;
    player_id: string;
    rationale: string;
    confidence: number;
    primary_factor: (typeof factors)[number];
  }[];
  thesis: string;
  projected_score: number;
  confidence: number;
  skill_version: string;
};

export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AgentError("Invalid API object");

  return value as Record<string, any>;
}

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const number = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function parseContest(value: unknown): Contest {
  const v = object(value);

  if (!["open", "locked", "settled"].includes(v.status))
    throw new AgentError("Unsupported contest status");

  if (
    !text(v.id) ||
    !/^\d{4}-W\d{2}$/.test(v.id) ||
    !Number.isFinite(Date.parse(v.lock_time)) ||
    !Number.isFinite(Date.parse(v.now)) ||
    !number(v.seconds_until_lock) ||
    !Number.isSafeInteger(v.salary_cap) ||
    v.salary_cap <= 0 ||
    !text(v.scoring_version) ||
    !text(v.salary_version) ||
    !Array.isArray(v.roster_slots) ||
    !v.roster_slots.length ||
    v.roster_slots.some(
      (s: any) =>
        !s ||
        !text(s.slot) ||
        !Array.isArray(s.positions) ||
        !s.positions.length ||
        !s.positions.every(text),
    ) ||
    new Set(v.roster_slots.map((s: any) => s.slot)).size !==
      v.roster_slots.length
  )
    throw new AgentError("Invalid contest data");

  return v as Contest;
}

export function parsePool(value: unknown, contest: Contest): Pool {
  const v = object(value);

  if (
    v.contest_id !== contest.id ||
    v.salary_version !== contest.salary_version ||
    !text(v.attribution) ||
    !Array.isArray(v.players) ||
    !v.players.length ||
    v.players.some(
      (p: any) =>
        !p ||
        !["player_id", "name", "team", "position", "opponent", "kickoff"].every(
          (k) => text(p[k]),
        ) ||
        !Number.isFinite(Date.parse(p.kickoff)) ||
        !Number.isSafeInteger(p.salary) ||
        p.salary < 0,
    ) ||
    new Set(v.players.map((p: any) => p.player_id)).size !== v.players.length
  )
    throw new AgentError("Invalid player pool");

  return v as Pool;
}

function exact(v: Record<string, any>, keys: string[]) {
  if (Object.keys(v).length !== keys.length || keys.some((k) => !(k in v)))
    throw new AgentError("Unexpected lineup fields");
}

function prose(v: unknown, max: number) {
  if (!text(v) || v.length > max || v.trim().split(/\s+/).length < 15)
    throw new AgentError("Reasoning must contain at least 15 words");
}

function confidence(v: unknown) {
  if (!number(v) || v < 0 || v > 1) throw new AgentError("Invalid confidence");
}

export function validateLineup(
  value: unknown,
  contest: Contest,
  pool: Pool,
  version: string,
  secrets: string[] = [],
): Lineup {
  const v = object(value);
  exact(v, [
    "players",
    "thesis",
    "projected_score",
    "confidence",
    "skill_version",
  ]);

  if (
    v.skill_version !== version ||
    !Array.isArray(v.players) ||
    v.players.length !== contest.roster_slots.length
  )
    throw new AgentError("Lineup slot/version mismatch");
  prose(v.thesis, 4000);
  confidence(v.confidence);

  if (
    !number(v.projected_score) ||
    v.projected_score < 0 ||
    v.projected_score > 500
  )
    throw new AgentError("Invalid projected score");

  const ids = new Set<string>(),
    slots = new Set<string>(),
    rationales = new Set<string>();

  let salary = 0;

  for (const raw of v.players) {
    const p = object(raw);
    exact(p, [
      "slot",
      "player_id",
      "rationale",
      "confidence",
      "primary_factor",
    ]);
    prose(p.rationale, 2000);
    confidence(p.confidence);

    if (!(factors as readonly unknown[]).includes(p.primary_factor))
      throw new AgentError("Invalid primary factor");

    const slot = contest.roster_slots.find((s) => s.slot === p.slot);
    const player = pool.players.find((s) => s.player_id === p.player_id);

    if (!slot || !player || !slot.positions.includes(player.position))
      throw new AgentError("Invalid slot, player, or eligibility");

    if (
      slots.has(p.slot) ||
      ids.has(p.player_id) ||
      rationales.has(p.rationale.trim())
    )
      throw new AgentError("Duplicate slot, player, or rationale");
    slots.add(p.slot);
    ids.add(p.player_id);
    rationales.add(p.rationale.trim());
    salary += player.salary;
  }

  if (salary > contest.salary_cap)
    throw new AgentError("Lineup exceeds salary cap");

  const serialized = JSON.stringify(v);

  if (
    /mafl_live_[A-Za-z0-9]{32}|sk-[A-Za-z0-9_-]{16,}/.test(serialized) ||
    secrets.some((s) => s && serialized.includes(s))
  )
    throw new AgentError("Credential detected in lineup");

  return v as Lineup;
}

export function samePicks(a: Lineup, b: Lineup) {
  const signature = (l: Lineup) =>
    l.players
      .map((p) => `${p.slot}:${p.player_id}`)
      .sort()
      .join("|");

  return signature(a) === signature(b);
}

export const lineupSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    players: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          slot: { type: "string" },
          player_id: { type: "string" },
          rationale: { type: "string" },
          confidence: { type: "number" },
          primary_factor: { type: "string", enum: [...factors] },
        },
        required: [
          "slot",
          "player_id",
          "rationale",
          "confidence",
          "primary_factor",
        ],
      },
    },
    thesis: { type: "string" },
    projected_score: { type: "number" },
    confidence: { type: "number" },
    skill_version: { type: "string" },
  },
  required: [
    "players",
    "thesis",
    "projected_score",
    "confidence",
    "skill_version",
  ],
};
