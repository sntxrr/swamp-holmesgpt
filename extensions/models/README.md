# @sntxrr/holmesgpt

Ask a [HolmesGPT](https://holmesgpt.dev) server to investigate a question, and
keep its answer as versioned swamp data.

HolmesGPT is an SRE agent. It answers a question by calling its own toolsets
(Prometheus, Docker, logs, your own) and reasoning over what they return. This
model talks to its HTTP API with Deno's built-in `fetch`, so it has no
dependencies.

## Methods

| Method   | Writes? | What it does                                                     |
| -------- | ------- | ---------------------------------------------------------------- |
| `ask`    | no      | Send a question to `/api/chat`, store the answer                 |
| `health` | no      | Check `/healthz` and `/readyz`, store the server's list of models |

Neither method changes anything on the HolmesGPT server. `ask` does spend LLM
tokens, and HolmesGPT runs whichever of its tools the question leads it to.

## Setup

```bash
swamp extension pull @sntxrr/holmesgpt

swamp behavior create @sntxrr/holmesgpt holmes \
  --global-arg baseUrl=http://holmes.example:5050 \
  --global-arg 'apiKey=${{ vault.get("my-vault", "holmes-api-key") }}'

swamp behavior run holmes health
swamp behavior run holmes ask \
  --input question="why did the nightly backup fail?" \
  --input requestId=nightly-backup
```

| Global argument | Required | Notes                                                                  |
| --------------- | -------- | ---------------------------------------------------------------------- |
| `baseUrl`       | yes      | The server itself. A vhost behind SSO answers an API call with a redirect |
| `apiKey`        | no       | The server's `HOLMES_API_KEY`. Sensitive: swamp only accepts a vault reference |
| `defaultModel`  | no       | With a server model list, the list's key name, not the provider's model id |
| `timeoutMs`     | no       | Default 600000. An investigation takes minutes                          |

## `ask`

| Argument                 | Notes                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `question`               | Required                                                                 |
| `requestId`              | Name of the stored result, default `ask`. Use one per subject            |
| `model`                  | Overrides `defaultModel`                                                 |
| `additionalSystemPrompt` | Context a workflow already gathered, appended to HolmesGPT's system prompt |
| `extendedPlanning`       | Turns on HolmesGPT's planning phase. Slower, more tokens                 |
| `responseSchema`         | A JSON schema the answer must match; the parsed answer is stored as `structured` |

The stored `investigation` holds the question, the `analysis`, `structured`
(when a schema was given), the model, the duration, and for each tool call its
name, toolset, description and status.

Use `responseSchema` when a workflow has to branch on the answer:

```yaml
responseSchema:
  type: object
  properties:
    needsHuman: { type: boolean }
    summary: { type: string }
  required: [needsHuman, summary]
  additionalProperties: false
```

```
data.latest("holmes", "nightly-backup").attributes.structured.needsHuman
```

## What to know before you rely on it

- **Everything goes to the LLM provider.** The question, the system prompt and
  the output of every tool HolmesGPT runs are sent to whichever provider the
  server is configured with. Hostnames and log lines in tool output are not
  scrubbed. Choose the server's toolsets with that in mind.
- **Tool output is not stored.** Only each tool call's name and status are
  kept, not what it returned, and not the conversation history.
- **`ask` is never retried.** A failed investigation may already have spent
  tokens and run tools, so repeating it is left to the caller.
- **A 401 has two meanings.** HolmesGPT answers 401 when its own API key is
  wrong and also when its LLM provider rejects the provider key. The error
  message says which.
- **`health` proves nothing about `apiKey`.** The two endpoints it reads are
  unauthenticated. Only an `ask` proves the key.
- **`health` fails the run when the server is not ready or cannot be
  reached**, after storing the state it saw (`healthy: false`).

Measured against HolmesGPT 0.46.0.
