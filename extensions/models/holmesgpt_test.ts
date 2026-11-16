// extensions/models/holmesgpt_test.ts
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20261108.72";
import { model } from "./holmesgpt.ts";

type AskContext = Parameters<typeof model.methods.ask.execute>[1];
type HealthContext = Parameters<typeof model.methods.health.execute>[1];

const GLOBAL_ARGS = {
  baseUrl: "http://holmes.example:5050",
  apiKey: "test-key",
  timeoutMs: 5_000,
};

function askContext(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const ctx = createModelTestContext({ globalArgs, methodName: "ask" });
  return { ...ctx, context: ctx.context as unknown as AskContext };
}

function healthContext(globalArgs: Record<string, unknown> = GLOBAL_ARGS) {
  const ctx = createModelTestContext({ globalArgs, methodName: "health" });
  return { ...ctx, context: ctx.context as unknown as HealthContext };
}

function askArgs(overrides: Record<string, unknown> = {}) {
  return {
    question: "why is the disk full?",
    requestId: "ask",
    extendedPlanning: false,
    ...overrides,
  };
}

Deno.test("ask stores the analysis and a summary of the tool calls", async () => {
  const { context, getWrittenResources } = askContext();
  let sent: Record<string, unknown> = {};

  await withMockedFetch(
    async (req) => {
      assertEquals(req.url, "http://holmes.example:5050/api/chat");
      assertEquals(req.method, "POST");
      assertEquals(req.headers.get("Authorization"), "Bearer test-key");
      sent = await req.json();
      return Response.json({
        analysis: "The disk is full of old backups.",
        conversation_history: [{ role: "system", content: "huge prompt" }],
        tool_calls: [
          {
            tool_call_id: "t1",
            tool_name: "docker_ps",
            toolset_name: "docker/core",
            description: "docker ps",
            result: { status: "success", data: "RAW TOOL OUTPUT" },
          },
          { tool_call_id: "t2", tool_name: "df", result: { status: "error" } },
          { not: "a tool call" },
        ],
      });
    },
    async () => {
      await model.methods.ask.execute(askArgs(), context);
    },
  );

  assertEquals(sent, { ask: "why is the disk full?" });

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "investigation");
  assertEquals(written[0].name, "ask");
  assertEquals(written[0].data.analysis, "The disk is full of old backups.");
  assertEquals(written[0].data.toolCallCount, 2);
  assertEquals(written[0].data.toolCalls, [
    {
      toolName: "docker_ps",
      toolsetName: "docker/core",
      description: "docker ps",
      status: "success",
    },
    { toolName: "df", status: "error" },
  ]);
  // Neither the tool output nor the conversation history is kept.
  const stored = JSON.stringify(written[0].data);
  assertEquals(stored.includes("RAW TOOL OUTPUT"), false);
  assertEquals(stored.includes("huge prompt"), false);
});

Deno.test("ask sends the model, system prompt, planning and schema", async () => {
  const { context, getWrittenResources } = askContext({
    ...GLOBAL_ARGS,
    baseUrl: "http://holmes.example:5050/",
    defaultModel: "fast",
  });
  let sent: Record<string, unknown> = {};
  const schema = {
    type: "object",
    properties: { needsHuman: { type: "boolean" } },
    required: ["needsHuman"],
    additionalProperties: false,
  };

  await withMockedFetch(
    async (req) => {
      // A trailing slash on baseUrl must not double up.
      assertEquals(req.url, "http://holmes.example:5050/api/chat");
      sent = await req.json();
      return Response.json({
        analysis: '{"needsHuman": true}',
        conversation_history: [],
        tool_calls: [],
      });
    },
    async () => {
      await model.methods.ask.execute(
        askArgs({
          requestId: "disk-alert",
          additionalSystemPrompt: "triage said: unreachable",
          extendedPlanning: true,
          responseSchema: schema,
        }),
        context,
      );
    },
  );

  assertEquals(sent.model, "fast");
  assertEquals(sent.additional_system_prompt, "triage said: unreachable");
  assertEquals(sent.behavior_controls, {
    todowrite_instructions: true,
    todowrite_reminder: true,
  });
  assertEquals(sent.response_format, {
    type: "json_schema",
    json_schema: { name: "SwampInvestigation", strict: true, schema },
  });

  const written = getWrittenResources();
  assertEquals(written[0].name, "disk-alert");
  assertEquals(written[0].data.structured, { needsHuman: true });
  assertEquals(written[0].data.model, "fast");
});

Deno.test("ask sends no Authorization header without an apiKey", async () => {
  const { context } = askContext({ baseUrl: "http://holmes.example:5050" });

  await withMockedFetch(
    (req) => {
      assertEquals(req.headers.get("Authorization"), null);
      return Promise.resolve(
        Response.json({ analysis: "ok", conversation_history: [] }),
      );
    },
    async () => {
      await model.methods.ask.execute(askArgs(), context);
    },
  );
});

Deno.test("ask names its own apiKey when HolmesGPT rejects it", async () => {
  const { context, getWrittenResources } = askContext();

  const { result: err } = await withMockedFetch(
    () =>
      Promise.resolve(
        Response.json({ detail: "Invalid or missing API key" }, {
          status: 401,
        }),
      ),
    () =>
      assertRejects(
        () => model.methods.ask.execute(askArgs(), context),
        Error,
      ),
  );

  assertStringIncludes(err.message, "rejected this model's apiKey");
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("ask names the LLM provider when the provider rejects the server", async () => {
  const { context, getWrittenResources } = askContext();

  // The same 401 status as a bad apiKey; only the detail tells them apart.
  const { result: err } = await withMockedFetch(
    () =>
      Promise.resolve(
        Response.json({
          detail:
            'litellm.AuthenticationError: AnthropicException - {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        }, { status: 401 }),
      ),
    () =>
      assertRejects(
        () => model.methods.ask.execute(askArgs(), context),
        Error,
      ),
  );

  assertStringIncludes(err.message, "LLM provider rejected");
  assertEquals(err.message.includes("this model's apiKey"), false);
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("ask reports a 422 validation list and caps a long error body", async () => {
  const { context } = askContext();

  const { result: invalid } = await withMockedFetch(
    () =>
      Promise.resolve(
        Response.json({
          detail: [{ type: "missing", loc: ["body", "ask"] }],
        }, { status: 422 }),
      ),
    () =>
      assertRejects(
        () => model.methods.ask.execute(askArgs(), context),
        Error,
      ),
  );
  assertStringIncludes(invalid.message, "HolmesGPT API error 422");
  assertStringIncludes(invalid.message, '"loc":["body","ask"]');

  const { result: long } = await withMockedFetch(
    () => Promise.resolve(new Response("x".repeat(5_000), { status: 502 })),
    () =>
      assertRejects(
        () => model.methods.ask.execute(askArgs(), context),
        Error,
      ),
  );
  assertStringIncludes(long.message, "HolmesGPT API error 502");
  assertEquals(long.message.length < 600, true);
});

Deno.test("ask fails when the response has no analysis", async () => {
  const { context, getWrittenResources } = askContext();

  const { result: err } = await withMockedFetch(
    () => Promise.resolve(Response.json({ conversation_history: [] })),
    () =>
      assertRejects(
        () => model.methods.ask.execute(askArgs(), context),
        Error,
      ),
  );

  assertStringIncludes(err.message, 'no "analysis" string');
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("ask fails when a schema was given and the answer is not a JSON object", async () => {
  const { context, getWrittenResources } = askContext();
  const responseSchema = { type: "object" };

  for (const analysis of ["plain prose, not JSON", "[1, 2]"]) {
    await withMockedFetch(
      () =>
        Promise.resolve(Response.json({ analysis, conversation_history: [] })),
      () =>
        assertRejects(
          () => model.methods.ask.execute(askArgs({ responseSchema }), context),
          Error,
          "responseSchema",
        ),
    );
  }
  assertEquals(getWrittenResources().length, 0);
});

Deno.test('ask arguments refuse the reserved requestId "latest"', () => {
  const parsed = model.methods.ask.arguments.safeParse({
    question: "q",
    requestId: "latest",
  });
  assertEquals(parsed.success, false);
});

Deno.test("health records a ready server and its models", async () => {
  const { context, getWrittenResources } = healthContext();
  const seen: string[] = [];

  await withMockedFetch(
    (req) => {
      seen.push(req.url);
      // Neither endpoint is authenticated; the key must not be sent.
      assertEquals(req.headers.get("Authorization"), null);
      return Promise.resolve(
        req.url.endsWith("/healthz")
          ? Response.json({ status: "healthy" })
          : Response.json({ status: "ready", models: ["a/b", 7] }),
      );
    },
    async () => {
      await model.methods.health.execute({}, context);
    },
  );

  assertEquals(seen, [
    "http://holmes.example:5050/healthz",
    "http://holmes.example:5050/readyz",
  ]);
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "health");
  assertEquals(written[0].data.healthy, true);
  assertEquals(written[0].data.ready, true);
  assertEquals(written[0].data.models, ["a/b"]);
});

Deno.test("health records the state and then fails when not ready", async () => {
  const { context, getWrittenResources } = healthContext();

  const { result: err } = await withMockedFetch(
    (req) =>
      Promise.resolve(
        req.url.endsWith("/healthz")
          ? Response.json({ status: "healthy" })
          : Response.json({ detail: "Service not ready" }, { status: 503 }),
      ),
    () =>
      assertRejects(
        () => model.methods.health.execute({}, context),
        Error,
      ),
  );

  assertStringIncludes(err.message, "/readyz 503");
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].data.healthy, true);
  assertEquals(written[0].data.ready, false);
  assertEquals(written[0].data.models, []);
});
