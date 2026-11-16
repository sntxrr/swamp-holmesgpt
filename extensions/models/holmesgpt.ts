/**
 * HolmesGPT integration — ask a HolmesGPT HTTP server to investigate a
 * question and keep its answer as versioned swamp data.
 *
 * HolmesGPT (https://holmesgpt.dev) is an SRE agent: it answers a question by
 * calling its own toolsets (Prometheus, Docker, logs, ...) and reasoning over
 * what they return. This model talks to its HTTP API (`/api/chat`, `/healthz`,
 * `/readyz`) with Deno's built-in `fetch`.
 *
 * @module
 */
// extensions/models/holmesgpt.ts
import { z } from "npm:zod@4";

/** An investigation calls tools in a loop; minutes, not seconds. */
const DEFAULT_TIMEOUT_MS = 600_000;
const HEALTH_TIMEOUT_MS = 10_000;
/** Longest slice of a server error body that is put into a thrown error. */
const MAX_ERROR_DETAIL = 500;

const GlobalArgsSchema = z.object({
  baseUrl: z.string().url().describe(
    "Root of the HolmesGPT HTTP server, e.g. http://holmes.example:5050. Point it at the server itself, not at a vhost behind SSO: a forward-auth redirect reads as a broken endpoint.",
  ),
  apiKey: z.string().min(1).meta({ sensitive: true }).optional().describe(
    "The server's HOLMES_API_KEY, sent as a bearer token. Use a vault reference. Leave unset only for a server started without one.",
  ),
  defaultModel: z.string().optional().describe(
    "Model used when an ask doesn't override it. On a server with a model list this is the list's key name, not the provider's model id.",
  ),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS).describe(
    "HTTP timeout for one ask, in milliseconds. A stalled investigation is aborted and fails the run.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const AskArgsSchema = z.object({
  question: z.string().min(1).describe(
    "What HolmesGPT should investigate. Everything in it, and everything its tools return, is sent to the server's LLM provider.",
  ),
  // swamp reserves the data name "latest"; writing to it fails the run.
  requestId: z.string().min(1).refine((id) => id !== "latest", {
    message: 'requestId "latest" is reserved by swamp; use another name',
  }).default("ask").describe(
    "Instance name for the stored investigation. Use one per subject (an alert name, a host) to keep separate histories.",
  ),
  model: z.string().optional().describe("Overrides defaultModel for this ask"),
  additionalSystemPrompt: z.string().optional().describe(
    "Extra instructions appended to HolmesGPT's system prompt, e.g. context a workflow already gathered",
  ),
  extendedPlanning: z.boolean().default(false).describe(
    "Turn on HolmesGPT's planning phase for long, multi-step investigations. Slower and costs more tokens.",
  ),
  responseSchema: z.record(z.string(), z.unknown()).optional().describe(
    "A JSON schema (type object, additionalProperties false) the answer must match. The parsed answer is stored as `structured`, so a workflow can branch on a field instead of reading prose.",
  ),
});

type AskArgs = z.infer<typeof AskArgsSchema>;

const InvestigationSchema = z.object({
  question: z.string(),
  analysis: z.string(),
  structured: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  toolCalls: z.array(
    z.object({
      toolName: z.string(),
      toolsetName: z.string().optional(),
      description: z.string().optional(),
      status: z.string().optional(),
    }),
  ),
  toolCallCount: z.number(),
  durationMs: z.number(),
  askedAt: z.string(),
});

const HealthSchema = z.object({
  healthy: z.boolean(),
  ready: z.boolean(),
  models: z.array(z.string()),
  checkedAt: z.string(),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Join the server root and a path without doubling the slash. */
function endpoint(globalArgs: GlobalArgs, path: string): string {
  return `${globalArgs.baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Headers for an authenticated call; no Authorization without a key. */
function buildHeaders(globalArgs: GlobalArgs): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (globalArgs.apiKey) {
    headers.Authorization = `Bearer ${globalArgs.apiKey}`;
  }
  return headers;
}

/**
 * `fetch`, with a failure that says which server could not be reached and
 * why. A bare timeout or connection error names neither.
 */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    const reason = timedOut
      ? `no response within ${timeoutMs}ms`
      : (error instanceof Error ? error.message : String(error));
    throw new Error(`HolmesGPT unreachable at ${url}: ${reason}`);
  }
}

/**
 * Pull FastAPI's `detail` out of an error body, as text, capped in length.
 * `detail` is a string for most errors and a list for a 422.
 */
function errorDetail(body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (parsed && parsed.detail !== undefined) {
      detail = typeof parsed.detail === "string"
        ? parsed.detail
        : JSON.stringify(parsed.detail);
    }
  } catch {
    // Not JSON (a proxy's HTML error page, say): report it as it came.
  }
  return detail.length > MAX_ERROR_DETAIL
    ? `${detail.slice(0, MAX_ERROR_DETAIL)}…`
    : detail;
}

/**
 * Turn a failed `/api/chat` response into an error that names who rejected
 * what. HolmesGPT answers 401 both when its own API key is wrong and when its
 * LLM provider rejects the provider key, so the status alone cannot tell a
 * caller which credential to fix.
 */
function chatError(status: number, body: string): Error {
  const detail = errorDetail(body);
  if (status === 401) {
    return /invalid or missing api key/i.test(detail)
      ? new Error(
        `HolmesGPT rejected this model's apiKey (HTTP 401): ${detail}`,
      )
      : new Error(
        `HolmesGPT's LLM provider rejected the server's credential (HTTP 401): ${detail}`,
      );
  }
  if (status === 429) {
    return new Error(
      `HolmesGPT's LLM provider is rate limiting it (HTTP 429): ${detail}`,
    );
  }
  return new Error(`HolmesGPT API error ${status}: ${detail}`);
}

/**
 * Reduce HolmesGPT's tool-call records to what is worth keeping: which tool
 * ran and how it ended. The tool output itself is left out, because it is
 * large and is raw infrastructure data.
 */
function summarizeToolCalls(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw)) return [];
  const calls: Array<Record<string, string>> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const call = entry as Record<string, unknown>;
    if (typeof call.tool_name !== "string") continue;
    const summary: Record<string, string> = { toolName: call.tool_name };
    if (typeof call.toolset_name === "string") {
      summary.toolsetName = call.toolset_name;
    }
    if (typeof call.description === "string") {
      summary.description = call.description;
    }
    const result = call.result as Record<string, unknown> | undefined;
    if (result && typeof result.status === "string") {
      summary.status = result.status;
    }
    calls.push(summary);
  }
  return calls;
}

/**
 * HolmesGPT model definition — `ask` runs an investigation and stores the
 * answer, `health` records whether the server is up and which models it has.
 */
export const model = {
  type: "@sntxrr/holmesgpt",
  version: "2026.11.16.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "investigation": {
      description: "HolmesGPT's answer to one question, and the tools it used",
      schema: InvestigationSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "health": {
      description: "Whether the HolmesGPT server is up, ready, and its models",
      schema: HealthSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    ask: {
      description:
        "Ask HolmesGPT to investigate a question and store its answer",
      arguments: AskArgsSchema,
      execute: async (args: AskArgs, context: MethodContext) => {
        const { globalArgs, logger } = context;
        const model = args.model ?? globalArgs.defaultModel;

        const body: Record<string, unknown> = { ask: args.question };
        if (model) body.model = model;
        if (args.additionalSystemPrompt) {
          body.additional_system_prompt = args.additionalSystemPrompt;
        }
        if (args.extendedPlanning) {
          body.behavior_controls = {
            todowrite_instructions: true,
            todowrite_reminder: true,
          };
        }
        if (args.responseSchema) {
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: "SwampInvestigation",
              strict: true,
              schema: args.responseSchema,
            },
          };
        }

        logger.info("Asking HolmesGPT ({requestId})", {
          requestId: args.requestId,
        });

        // No retry. An investigation spends provider tokens and may already
        // have run tools by the time a request fails, so repeating it is the
        // caller's decision, not something to do behind its back.
        const started = Date.now();
        const res = await request(
          endpoint(globalArgs, "/api/chat"),
          {
            method: "POST",
            headers: buildHeaders(globalArgs),
            body: JSON.stringify(body),
          },
          globalArgs.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        if (!res.ok) throw chatError(res.status, await res.text());

        const reply = await res.json() as Record<string, unknown>;
        if (typeof reply.analysis !== "string") {
          throw new Error(
            `HolmesGPT response has no "analysis" string; it had: ${
              Object.keys(reply).join(", ") || "nothing"
            }`,
          );
        }

        let structured: Record<string, unknown> | undefined;
        if (args.responseSchema) {
          try {
            structured = JSON.parse(reply.analysis) as Record<string, unknown>;
          } catch {
            throw new Error(
              "HolmesGPT was given a responseSchema but its answer is not JSON",
            );
          }
          if (
            !structured || typeof structured !== "object" ||
            Array.isArray(structured)
          ) {
            throw new Error(
              "HolmesGPT was given a responseSchema but its answer is not a JSON object",
            );
          }
        }

        const toolCalls = summarizeToolCalls(reply.tool_calls);
        const durationMs = Date.now() - started;

        const handle = await context.writeResource(
          "investigation",
          args.requestId,
          {
            question: args.question,
            analysis: reply.analysis,
            ...(structured ? { structured } : {}),
            ...(model ? { model } : {}),
            toolCalls,
            toolCallCount: toolCalls.length,
            durationMs,
            askedAt: new Date(started).toISOString(),
          },
        );

        logger.info(
          "HolmesGPT answered {requestId} in {durationMs}ms using {toolCallCount} tool calls",
          {
            requestId: args.requestId,
            durationMs,
            toolCallCount: toolCalls.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    health: {
      description:
        "Check that the HolmesGPT server is up and ready, and record its models",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { globalArgs, logger } = context;

        logger.info("Checking HolmesGPT health");

        // /healthz and /readyz are the two endpoints the server leaves
        // unauthenticated, so this proves reachability and nothing about
        // apiKey. An `ask` is what proves the key.
        //
        // A server that cannot be reached is recorded the same way as one
        // that answers "not ready": the state is written, then the run fails.
        // What was observed is real data either way, and a workflow can read
        // `healthy: false` instead of finding the last good record.
        const probe = async (path: string) => {
          try {
            const res = await request(
              endpoint(globalArgs, path),
              {},
              HEALTH_TIMEOUT_MS,
            );
            return { res, problem: res.ok ? "" : `HTTP ${res.status}` };
          } catch (error) {
            return { res: undefined, problem: (error as Error).message };
          }
        };

        const health = await probe("/healthz");
        await health.res?.body?.cancel();
        const healthy = health.problem === "";

        const readiness = await probe("/readyz");
        const ready = readiness.problem === "";
        let models: string[] = [];
        if (ready && readiness.res) {
          const parsed = await readiness.res.json() as { models?: unknown };
          if (Array.isArray(parsed.models)) {
            models = parsed.models.filter((m): m is string =>
              typeof m === "string"
            );
          }
        } else {
          await readiness.res?.body?.cancel();
        }

        const handle = await context.writeResource("health", "current", {
          healthy,
          ready,
          models,
          checkedAt: new Date().toISOString(),
        });

        if (!healthy || !ready) {
          throw new Error(
            `HolmesGPT is not ready: /healthz ${
              health.problem || "ok"
            }, /readyz ${readiness.problem || "ok"}`,
          );
        }
        logger.info("HolmesGPT is ready with {count} models", {
          count: models.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
