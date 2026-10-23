import { createHash } from "node:crypto";
import { AgentError } from "./errors.js";
import { object, type Contest } from "./lineup.js";

export function isSkillVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    /^\d+\.\d+(?:\.\d+)?$/.test(value)
  );
}

export function observeSkill(text: string) {
  const markers = text.split(/\r?\n/).filter((line) => /^Version:/.test(line));
  const version = markers[0]?.match(
    /^Version:[ \t]*`([^`]+)`(?:[ \t].*)?$/,
  )?.[1];
  if (markers.length !== 1 || !isSkillVersion(version))
    throw new AgentError("Invalid MAFL skill version marker");
  return {
    version,
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

// Reviewed against /v1/scoring/schema: numeric values are data, not instructions.
export function parseScoring(value: unknown, contest: Contest) {
  const v = object(value);
  const version = v.version ?? v.scoring_version;
  if (
    typeof version !== "string" ||
    !version ||
    version !== contest.scoring_version ||
    (v.version !== undefined &&
      v.scoring_version !== undefined &&
      v.version !== v.scoring_version)
  )
    throw new AgentError("Scoring version mismatch");
  if (v.format !== "ppr") throw new AgentError("Unsupported scoring format");
  for (const [group, fields] of Object.entries({
    passing: [
      "yards_per_point",
      "touchdown",
      "interception",
      "two_point_conversion",
    ],
    rushing: ["yards_per_point", "touchdown", "two_point_conversion"],
    receiving: [
      "reception",
      "yards_per_point",
      "touchdown",
      "two_point_conversion",
    ],
  })) {
    const rules = object(v[group]);
    if (
      fields.some((field) => !Number.isFinite(rules[field])) ||
      rules.yards_per_point <= 0
    )
      throw new AgentError(`Invalid scoring fields: ${group}`);
  }
  if (!Number.isFinite(v.fumble_lost))
    throw new AgentError("Invalid scoring field: fumble_lost");
  return v;
}

export function assertSameRules(before: Contest, after: Contest) {
  const slots = (contest: Contest) =>
    JSON.stringify(
      contest.roster_slots
        .map((s) => ({
          slot: s.slot,
          positions: [...s.positions].sort(),
        }))
        .sort((a, b) => a.slot.localeCompare(b.slot)),
    );
  if (
    before.salary_cap !== after.salary_cap ||
    before.scoring_version !== after.scoring_version ||
    before.salary_version !== after.salary_version ||
    Date.parse(before.lock_time) !== Date.parse(after.lock_time) ||
    slots(before) !== slots(after)
  )
    throw new AgentError("Contest rules changed before submission");
}

export function lineupBody(value: unknown, fallbackVersion: string) {
  const v = object(value);
  if (!Array.isArray(v.players))
    throw new AgentError("Invalid recorded lineup players");
  const version = v.skill_version ?? fallbackVersion;
  if (!isSkillVersion(version))
    throw new AgentError("Invalid recorded lineup skill version");
  return {
    players: v.players.map((raw: unknown) => {
      const p = object(raw);
      return {
        slot: p.slot,
        player_id: p.player_id,
        rationale: p.rationale,
        confidence: p.confidence,
        primary_factor: p.primary_factor,
      };
    }),
    thesis: v.thesis,
    projected_score: v.projected_score,
    confidence: v.confidence,
    skill_version: version,
  };
}
