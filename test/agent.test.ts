import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnalyst } from "../src/agent.js";
import { readConfig } from "../src/config.js";
import { contest, pool, lineup } from "./fixtures.js";

const config = readConfig({
  ANTHROPIC_API_KEY: "test-key",
  ANTHROPIC_MODEL: "test-model",
});

const context = {
  contest,
  pool,
  scoring: { version: "2026.1" },
  existing: null,
  previous: null,
  results: null,
  version: "1.4",
};

const searched = [
  { type: "server_tool_use", id: "srv-1", name: "web_search", input: {} },
  {
    type: "web_search_tool_result",
    tool_use_id: "srv-1",
    content: [
      {
        type: "web_search_result",
        url: "https://www.nfl.com/news/test",
        title: "Report",
      },
    ],
  },
];

const cited = {
  type: "text",
  text: "Sourced research",
  citations: [
    {
      type: "web_search_result_location",
      url: "https://www.nfl.com/news/test",
      title: "Report",
      cited_text: "Report text",
    },
  ],
};

// Each scripted reply answers one streamed request, in order.
function mockClient(replies: object[]) {
  const requests: any[] = [];
  const client = {
    messages: {
      stream: (body: any, options: any) => {
        requests.push({ body: structuredClone(body), options });
        const reply = replies[requests.length - 1];
        return { finalMessage: async () => reply };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

test("research then structured generation keep keys out and bound calls", async () => {
  const { client, requests } = mockClient([
    { stop_reason: "end_turn", content: [...searched, cited], usage: {} },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(lineup) }],
      usage: {},
    },
  ]);

  const controller = new AbortController();
  const result = await createAnalyst(config, client)(
    context,
    controller.signal,
  );
  assert.equal(requests.length, 2);

  for (const { body, options } of requests) {
    assert.equal(options.signal, controller.signal);
    assert.equal(body.model, "test-model");
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.ok(!JSON.stringify(body).includes(config.apiKey));
  }
  assert.deepEqual(requests[0].body.tools, [
    { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  ]);
  assert.equal(requests[0].body.output_config, undefined);
  assert.equal(requests[1].body.tools, undefined);
  assert.equal(requests[1].body.output_config.format.type, "json_schema");
  assert.match(requests[1].body.messages[0].content, /Sourced research/);
  assert.deepEqual(result.lineup, lineup);
  assert.deepEqual(result.sources, [
    { url: "https://www.nfl.com/news/test", title: "Report" },
  ]);
});

test("a paused search turn is resumed with its content, then bounded", async () => {
  const paused = { stop_reason: "pause_turn", content: searched, usage: {} };
  const { client, requests } = mockClient([
    paused,
    { stop_reason: "end_turn", content: [cited], usage: {} },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(lineup) }],
      usage: {},
    },
  ]);
  const result = await createAnalyst(config, client)(
    context,
    new AbortController().signal,
  );
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].body.messages.at(-1), {
    role: "assistant",
    content: searched,
  });
  assert.equal(result.usage.research.length, 2);

  // A turn that keeps pausing stops after the bounded resumes and fails.
  const stuck = mockClient([paused, paused, paused, paused]);
  await assert.rejects(
    createAnalyst(config, stuck.client)(context, new AbortController().signal),
    /Research incomplete/,
  );
  assert.equal(stuck.requests.length, 3);
});

test("incomplete, refused, unsearched or uncited research prevents generation", async () => {
  for (const [reply, reason] of [
    [
      { stop_reason: "max_tokens", content: [...searched, cited] },
      /incomplete/,
    ],
    [
      {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber" },
        content: [],
      },
      /declined by model safeguards \(cyber\)/,
    ],
    [{ stop_reason: "end_turn", content: [cited] }, /web search/],
    [
      {
        stop_reason: "end_turn",
        content: [
          searched[0],
          {
            ...searched[1],
            content: {
              type: "web_search_tool_result_error",
              error_code: "max_uses_exceeded",
            },
          },
          cited,
        ],
      },
      /web search/,
    ],
    [
      {
        stop_reason: "end_turn",
        content: [...searched, { type: "text", text: "No citations" }],
      },
      /no cited sources/,
    ],
  ] as const) {
    const { client, requests } = mockClient([{ usage: {}, ...reply }]);
    await assert.rejects(
      createAnalyst(config, client)(context, new AbortController().signal),
      reason,
    );
    assert.equal(requests.length, 1);
  }
});

test("effort is sent only when configured", async () => {
  const { client, requests } = mockClient([
    { stop_reason: "end_turn", content: [...searched, cited], usage: {} },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(lineup) }],
      usage: {},
    },
  ]);
  await createAnalyst(
    readConfig({
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "test-model",
      AGENT_EFFORT: "high",
    }),
    client,
  )(context, new AbortController().signal);
  assert.deepEqual(requests[0].body.output_config, { effort: "high" });
  assert.equal(requests[1].body.output_config.effort, "high");
});
