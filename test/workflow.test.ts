import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/workflow.js";
import { readConfig } from "../src/config.js";
import { loadState, saveState, acquireLock } from "../src/state.js";
import { contest, pool, lineup, recorded, scoring } from "./fixtures.js";

async function setup(t: any, mode = "", version = "1.4") {
  const dir = await mkdtemp(join(tmpdir(), "mafl-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const config = readConfig({
    ANTHROPIC_API_KEY: "anthropic-test-key",
    ANTHROPIC_MODEL: "test-model",
    MAFL_API_KEY: `mafl_live_${"a".repeat(32)}`,
    AGENT_STATE_DIR: dir,
  });

  const calls: { path: string; body: any; key: string | null }[] = [];
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const inputs: unknown[] = [];
  let submitted = false,
    analyses = 0;
  const generated = { ...lineup, skill_version: version };
  let submittedBody = generated;

  const fetcher = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);

    if (url === "https://mafl.ai/skill.md") {
      assert.equal(headers.has("Authorization"), false);

      if (mode === "cached" && headers.has("If-None-Match"))
        return new Response(null, { status: 304 });

      return new Response(
        `Version: \`${version}\`\n${mode === "changed-text" ? "Changed document" : ""}`,
        { headers: { ETag: "test-etag" } },
      );
    }
    assert.equal(headers.get("Authorization"), `Bearer ${config.maflKey}`);
    assert.equal(init.redirect, "error");

    const path = url.replace("https://api.mafl.ai/v1", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, key: headers.get("Idempotency-Key") });

    if (path === "/contests/current" && mode === "closed")
      return Response.json(
        { code: "no_open_contest", message: "none", fix: "later" },
        { status: 404 },
      );

    if (path === "/contests/current") {
      const refreshed = calls.filter((c) => c.path === path).length > 1;
      return Response.json({
        ...contest,
        ...(mode === "unknown-status" ? { status: "future" } : {}),
        ...(mode === "changed-rules" && refreshed ? { salary_cap: 40000 } : {}),
        extra_field: "additive",
      });
    }

    if (path.endsWith("/players")) return Response.json(pool);

    if (path === "/scoring")
      return Response.json({
        ...scoring,
        ...(mode === "bad-scoring" ? { scoring_version: "different" } : {}),
      });

    if (path === "/agents/me") return Response.json({ model: "test-model" });

    if (path.endsWith("/lineups/me"))
      return Response.json({
        contest_id: contest.id,
        lineup:
          mode === "bad-lineup"
            ? { players: null }
            : submitted
              ? { ...submittedBody, lineup_id: recorded.lineup_id, revision: 1 }
              : mode === "unchanged"
                ? recorded
                : null,
      });

    if (path.endsWith("?dry_run=true") && mode === "bad-preview")
      return Response.json({ contest_id: contest.id, dry_run: true });

    if (path.endsWith("?dry_run=true"))
      return mode === "rejected-preview"
        ? Response.json({ code: "invalid_request" }, { status: 400 })
        : Response.json({
            contest_id: contest.id,
            lock_time: contest.lock_time,
            dry_run: true,
            lineup: {
              ...body,
              lineup_id: null,
              revision: null,
              submitted_at: null,
              salary_total: 13000,
              salary_cap: contest.salary_cap,
            },
          });

    if (path.endsWith("/lineups")) {
      submitted = true;
      submittedBody = body;

      if (mode === "ambiguous") throw new Error("Connection lost");

      return Response.json({ dry_run: false }, { status: 201 });
    }
    throw new Error(`Unexpected test route ${path}`);
  }) as typeof fetch;

  const analyst = async (context: unknown) => {
    analyses++;
    inputs.push(context);

    return {
      lineup: generated,
      research: "Research",
      sources: [{ url: "https://www.nfl.com", title: "Report" }],
      usage: { research: null, lineup: null },
    };
  };

  return {
    config,
    calls,
    events,
    inputs,
    agent: createAgent(config, {
      fetcher,
      analyst: analyst as any,
      onEvent: (event, fields) => events.push({ event, fields }),
    }),
    analyses: () => analyses,
  };
}

test("dry-run then identical submission/read-back persist confirmation", async (t) => {
  const s = await setup(t);
  const result = await s.agent(new AbortController().signal);
  assert.equal(result.status, "submitted");

  const writes = s.calls.filter((c) => c.body);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0]!.body, writes[1]!.body);
  assert.equal(writes[0]!.key, writes[1]!.key);

  const state = await loadState(s.config.stateDir);
  assert.equal(state.pending, undefined);
  assert.equal(state.last?.contestId, contest.id);
});

test("dry-run never submits or stores pending write", async (t) => {
  const s = await setup(t);
  assert.equal(
    (await s.agent(new AbortController().signal, true)).status,
    "dry_run",
  );
  assert.equal(s.calls.filter((c) => c.body).length, 1);
  assert.equal((await loadState(s.config.stateDir)).pending, undefined);
});

test("no open contest and unchanged selections do not submit", async (t) => {
  const closed = await setup(t, "closed");
  assert.equal(
    (await closed.agent(new AbortController().signal)).status,
    "no_open_contest",
  );
  assert.equal(closed.analyses(), 0);

  const same = await setup(t, "unchanged");
  assert.equal(
    (await same.agent(new AbortController().signal)).status,
    "unchanged",
  );
  assert.equal(same.calls.filter((c) => c.body).length, 0);
});

test("ambiguous failure retains exact pending body for next-run replay without another model call", async (t) => {
  const s = await setup(t, "ambiguous");
  await assert.rejects(s.agent(new AbortController().signal));

  const state = await loadState(s.config.stateDir);
  assert.ok(state.pending);

  const next = await setup(t);
  await saveState(next.config.stateDir, state);
  assert.equal(
    (await next.agent(new AbortController().signal)).status,
    "submitted",
  );
  assert.equal(next.analyses(), 0);

  const writes = next.calls.filter((c) => c.body);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.key, state.pending.key);
  assert.deepEqual(writes[0]!.body, state.pending.body);
});

test("cross-process lock blocks overlapping invocations", async (t) => {
  const s = await setup(t);
  const release = await acquireLock(s.config.stateDir);
  await assert.rejects(s.agent(new AbortController().signal), /Another agent/);
  await release();
});

test("previously successful pending submission recovers after lock without another write", async (t) => {
  const s = await setup(t, "unchanged");
  await saveState(s.config.stateDir, {
    pending: { contestId: contest.id, key: "original-key", body: lineup },
  });
  assert.equal(
    (await s.agent(new AbortController().signal)).status,
    "submission_recovered",
  );
  assert.equal(s.calls.filter((c) => c.body).length, 0);
  assert.equal(s.analyses(), 0);
  assert.equal((await loadState(s.config.stateDir)).pending, undefined);
});

test("new minor and major versions submit and document prose stays out of analyst context", async (t) => {
  for (const version of ["1.8", "2.0"]) {
    const s = await setup(t, "changed-text", version);
    assert.equal(
      (await s.agent(new AbortController().signal)).status,
      "submitted",
    );
    assert.equal(s.events[0]?.event, "mafl_skill_observed");
    assert.equal(JSON.stringify(s.inputs).includes("Changed document"), false);
  }
});

test("legacy cache observes same-version edits once even if a later check fails", async (t) => {
  const s = await setup(t, "bad-scoring", "1.8");
  await saveState(s.config.stateDir, {
    skill: { text: "Version: `1.8`\nOld", etag: "old" },
  });
  await assert.rejects(
    s.agent(new AbortController().signal),
    /Scoring version/,
  );
  assert.equal(s.events[0]?.event, "mafl_skill_changed");
  assert.equal(s.events[0]?.fields.previousVersion, "1.8");
  await assert.rejects(
    s.agent(new AbortController().signal),
    /Scoring version/,
  );
  assert.equal(s.events.length, 1);
  assert.equal(s.analyses(), 0);
});

test("invalid read contracts stop before paid analysis", async (t) => {
  for (const mode of ["unknown-status", "bad-scoring", "bad-lineup"]) {
    const s = await setup(t, mode);
    await assert.rejects(s.agent(new AbortController().signal));
    assert.equal(s.analyses(), 0);
    assert.equal(s.calls.filter((c) => c.body).length, 0);
  }
});

test("changed rules or server preview rejection prevent real writes", async (t) => {
  for (const mode of ["changed-rules", "rejected-preview", "bad-preview"]) {
    const s = await setup(t, mode);
    await assert.rejects(s.agent(new AbortController().signal));
    assert.equal(s.calls.filter((c) => c.path.endsWith("/lineups")).length, 0);
    assert.equal((await loadState(s.config.stateDir)).pending, undefined);
  }
});

test("304 cache reuse retains observation without repeat notices", async (t) => {
  const s = await setup(t, "cached", "1.8");
  await s.agent(new AbortController().signal, true);
  const first = (await loadState(s.config.stateDir)).skill;
  await s.agent(new AbortController().signal, true);
  assert.equal(s.events.length, 1);
  assert.deepEqual((await loadState(s.config.stateDir)).skill, first);
});

test("older pending version replays unchanged after document bump and survives blocked replay", async (t) => {
  const pending = { contestId: contest.id, key: "original-key", body: lineup };
  const s = await setup(t, "", "1.8");
  await saveState(s.config.stateDir, { pending });
  assert.equal(
    (await s.agent(new AbortController().signal)).status,
    "submitted",
  );
  assert.equal(s.analyses(), 0);
  const writes = s.calls.filter((c) => c.body);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.body, pending.body);
  assert.equal(writes[0]!.key, pending.key);

  const blocked = await setup(t, "changed-rules", "1.8");
  await saveState(blocked.config.stateDir, { pending });
  await assert.rejects(
    blocked.agent(new AbortController().signal),
    /rules changed/,
  );
  assert.deepEqual((await loadState(blocked.config.stateDir)).pending, pending);
});

test("older pending version reconciles after bump; dry-run leaves pending untouched", async (t) => {
  const pending = { contestId: contest.id, key: "original-key", body: lineup };
  const recovered = await setup(t, "unchanged", "2.0");
  await saveState(recovered.config.stateDir, { pending });
  assert.equal(
    (await recovered.agent(new AbortController().signal)).status,
    "submission_recovered",
  );
  assert.equal(recovered.calls.filter((c) => c.body).length, 0);
  const dry = await setup(t, "", "2.0");
  await saveState(dry.config.stateDir, { pending });
  assert.equal(
    (await dry.agent(new AbortController().signal, true)).status,
    "dry_run",
  );
  assert.deepEqual((await loadState(dry.config.stateDir)).pending, pending);
  assert.equal(dry.calls.filter((c) => c.path.endsWith("/lineups")).length, 0);
});
