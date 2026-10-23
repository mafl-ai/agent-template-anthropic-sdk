import { AgentError } from "./errors.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { createAnalyst } from "./agent.js";
import { MaflClient, MaflError } from "./mafl.js";
import {
  parseContest,
  parsePool,
  object,
  validateLineup,
  samePicks,
  type Lineup,
} from "./lineup.js";
import { acquireLock, loadState, saveState } from "./state.js";
import {
  assertSameRules,
  isSkillVersion,
  lineupBody,
  observeSkill,
  parseScoring,
} from "./compatibility.js";

function matchesBody(value: unknown, body: Lineup): boolean {
  if (!value || typeof value !== "object") return false;

  const recorded = object(value);

  return (
    recorded.thesis === body.thesis &&
    recorded.projected_score === body.projected_score &&
    recorded.confidence === body.confidence &&
    recorded.skill_version === body.skill_version &&
    Array.isArray(recorded.players) &&
    recorded.players.length === body.players.length &&
    body.players.every((p) =>
      recorded.players.some(
        (r: any) =>
          r &&
          typeof r === "object" &&
          Object.entries(p).every(([k, v]) => r[k] === v),
      ),
    )
  );
}

function matchesRecorded(value: unknown, body: Lineup): boolean {
  if (!value || typeof value !== "object") return false;
  const recorded = object(value);
  return (
    typeof recorded.lineup_id === "string" &&
    !!recorded.lineup_id &&
    Number.isInteger(recorded.revision) &&
    recorded.revision > 0 &&
    matchesBody(value, body)
  );
}

export function createAgent(
  config: Config,
  deps: {
    fetcher?: typeof fetch;
    analyst?: ReturnType<typeof createAnalyst>;
    onEvent?: (event: string, fields: Record<string, unknown>) => void;
  } = {},
) {
  const analyst = deps.analyst ?? createAnalyst(config);

  return async (signal: AbortSignal, dryRun = false) => {
    const release = await acquireLock(config.stateDir);
    try {
      let key = config.maflKey;

      if (!key) {
        try {
          key = (await readFile(config.maflKeyFile, "utf8")).trim();
        } catch {
          throw new AgentError(
            "Set MAFL_API_KEY or save your key in .mafl-key",
          );
        }
      }

      if (!/^mafl_live_[A-Za-z0-9]{32}$/.test(key))
        throw new AgentError("Invalid MAFL key format");

      const api = new MaflClient(key, config.timeoutMs, deps.fetcher);
      const state = await loadState(config.stateDir);
      const skill = await api.skill(signal, state.skill);
      let previous: ReturnType<typeof observeSkill> | undefined;
      try {
        if (typeof state.skill?.text === "string")
          previous = observeSkill(state.skill.text);
      } catch {
        // Invalid legacy metadata cannot establish a previous observation.
      }
      if (!previous || previous.contentHash !== skill.contentHash)
        deps.onEvent?.(
          previous ? "mafl_skill_changed" : "mafl_skill_observed",
          {
            version: skill.version,
            contentHash: skill.contentHash,
            ...(previous
              ? {
                  previousVersion: previous.version,
                  previousContentHash: previous.contentHash,
                }
              : {}),
          },
        );
      state.skill = skill;
      await saveState(config.stateDir, state);

      // Confirm a possibly successful write even after the contest has locked.
      // --dry-run only inspects state; it must not finalize pending real writes.
      if (state.pending && !dryRun) {
        const check = await api.request(
          `/contests/${state.pending.contestId}/lineups/me`,
          signal,
        );

        if (matchesRecorded(check.lineup, state.pending.body)) {
          state.last = {
            contestId: state.pending.contestId,
            body: state.pending.body,
          };
          delete state.pending;
          await saveState(config.stateDir, state);

          return {
            status: "submission_recovered",
            contestId: state.last.contestId,
            lineupId: check.lineup.lineup_id,
            revision: check.lineup.revision,
          };
        }
      }

      if (state.last && !state.results?.[state.last.contestId]) {
        try {
          const result = await api.request(
            `/contests/${state.last.contestId}/results`,
            signal,
          );
          state.results = { ...state.results, [state.last.contestId]: result };
          await saveState(config.stateDir, state);
        } catch (e) {
          if (!(
            e instanceof MaflError &&
            ["not_settled", "no_lineup_recorded"].includes(e.code)
          ))
            throw e;
        }
      }

      let raw: unknown;
      try {
        raw = await api.request("/contests/current", signal);
      } catch (e) {
        if (e instanceof MaflError && e.code === "no_open_contest")
          return { status: "no_open_contest" };
        throw e;
      }

      const contest = parseContest(raw);

      if (contest.status !== "open" || contest.seconds_until_lock <= 0)
        return { status: "contest_locked", contestId: contest.id };

      const pool = parsePool(
        await api.request(`/contests/${contest.id}/players`, signal),
        contest,
      );

      const identity = await api.request("/agents/me", signal);

      if (identity.model !== config.model)
        throw new AgentError(
          "Registered MAFL model differs from ANTHROPIC_MODEL",
        );

      const scoring = parseScoring(
        await api.request("/scoring", signal),
        contest,
      );

      const current = await api.request(
        `/contests/${contest.id}/lineups/me`,
        signal,
      );

      if (current.contest_id !== contest.id)
        throw new AgentError("Lineup contest mismatch");

      const existing =
        current.lineup === null
          ? null
          : (() => {
              const body = lineupBody(current.lineup, skill.version);
              return validateLineup(body, contest, pool, body.skill_version);
            })();

      let body: Lineup,
        idempotencyKey: string,
        analysis:
          Awaited<ReturnType<ReturnType<typeof createAnalyst>>> | undefined;

      if (state.pending?.contestId === contest.id && !dryRun) {
        // Reuse the exact bytes/ID after ambiguous network failure; never regenerate first.
        if (!isSkillVersion(state.pending.body.skill_version))
          throw new AgentError("Invalid pending lineup skill version");
        body = validateLineup(
          state.pending.body,
          contest,
          pool,
          state.pending.body.skill_version,
          [key, config.apiKey],
        );
        idempotencyKey = state.pending.key;
      } else {
        analysis = await analyst(
          {
            contest,
            pool,
            scoring,
            existing,
            previous: state.last,
            results: state.results,
            version: skill.version,
          },
          signal,
        );

        if (
          [key, config.apiKey].some((secret) =>
            JSON.stringify(analysis).includes(secret),
          )
        )
          throw new AgentError("Credential detected in analysis");
        body = validateLineup(analysis.lineup, contest, pool, skill.version, [
          key,
          config.apiKey,
        ]);

        if (
          state.last &&
          state.last.contestId !== contest.id &&
          (body.thesis === state.last.body.thesis ||
            body.players.some((p) =>
              state.last!.body.players.some(
                (old) => old.rationale === p.rationale,
              ),
            ))
        )
          throw new AgentError("Previous-week reasoning reused");

        if (existing && samePicks(body, existing))
          return {
            status: "unchanged",
            contestId: contest.id,
            sources: analysis.sources,
            attribution: pool.attribution,
          };
        idempotencyKey = randomUUID();
      }

      const refreshed = parseContest(
        await api.request("/contests/current", signal),
      );

      if (
        refreshed.id !== contest.id ||
        refreshed.status !== "open" ||
        refreshed.seconds_until_lock <= 0
      )
        return { status: "contest_locked", contestId: contest.id };

      assertSameRules(contest, refreshed);

      // An existing pending payload may already have succeeded. Replay directly so
      // a now-exhausted revision quota cannot prevent idempotent recovery.
      if (dryRun || state.pending?.contestId !== contest.id) {
        const preview = await api.request(
          `/contests/${contest.id}/lineups?dry_run=true`,
          signal,
          body,
          idempotencyKey,
        );

        if (
          preview.dry_run !== true ||
          preview.contest_id !== contest.id ||
          !Number.isFinite(Date.parse(preview.lock_time)) ||
          Date.parse(preview.lock_time) !== Date.parse(contest.lock_time) ||
          !preview.lineup ||
          preview.lineup.lineup_id !== null ||
          preview.lineup.revision !== null ||
          preview.lineup.submitted_at !== null ||
          !matchesBody(preview.lineup, body) ||
          preview.lineup.salary_cap !== contest.salary_cap ||
          preview.lineup.salary_total !==
            body.players.reduce(
              (total, p) =>
                total +
                pool.players.find((player) => player.player_id === p.player_id)!
                  .salary,
              0,
            )
        )
          throw new AgentError("Unexpected dry-run response");
      }

      if (dryRun)
        return {
          status: "dry_run",
          contestId: contest.id,
          lineup: body,
          sources: analysis?.sources,
          research: analysis?.research,
          attribution: pool.attribution,
          usage: analysis?.usage,
        };
      state.pending = { contestId: contest.id, key: idempotencyKey, body };
      await saveState(config.stateDir, state);
      await api.request(
        `/contests/${contest.id}/lineups`,
        signal,
        body,
        idempotencyKey,
      );

      const confirmed = await api.request(
        `/contests/${contest.id}/lineups/me`,
        signal,
      );

      const recorded = object(confirmed.lineup);

      if (!matchesRecorded(recorded, body))
        throw new AgentError("Submitted lineup read-back mismatch");
      await api.request("/agents/me", signal);
      state.last = { contestId: contest.id, body };
      delete state.pending;
      await saveState(config.stateDir, state);

      return {
        status: "submitted",
        contestId: contest.id,
        lineupId: recorded.lineup_id,
        revision: recorded.revision,
        lineup: body,
        sources: analysis?.sources,
        research: analysis?.research,
        attribution: pool.attribution,
        usage: analysis?.usage,
      };
    } finally {
      await release();
    }
  };
}
