---
name: Poe-Setup
description: >-
  Self-contained guide for integrating the Poe API into any JavaScript or
  TypeScript Replit app. Use it whenever an app needs Poe models, an
  OpenAI-compatible client, structured output, tool calling, vision, or
  streamed AI responses. Covers provider-wrapper selection, secret handling,
  live model discovery, resilient server routes, and portable testing without
  assuming any existing app architecture.
---

# Poe API Integration — Portable, Chatbot-Oriented Setup Guide

Poe exposes an OpenAI-compatible API at `https://api.poe.com/v1`. The endpoint
accepts common OpenAI request shapes, but compatibility does not mean every
model supports every capability or parameter. Discover the live catalogue and
verify the capability metadata and current Poe documentation for the exact
model and endpoint actually selected.

This guide is a provider-specific transport guide behind a provider-neutral
application boundary. The application should choose a capability-appropriate
model through an explicit intake and registry process, then let one server-side
provider adapter perform the Poe call.

## 1. Intake before model selection

Do not choose a model from a familiar name, an old example, or a vague request.
For each chatbot or route, gather these fields in order:

1. **Goal and use case:** What should the user accomplish, and what is success?
2. **Input contract:** Text only, images, audio, files, structured records, or a
   bounded combination? What MIME types, sizes, and trust boundaries apply?
3. **Output contract:** Free text, a schema-validated JSON object, a tool request,
   a streamed response, or another explicitly validated shape?
4. **Required capabilities:** Vision, tools, structured output, reasoning,
   streaming, long context, or multi-turn state. Mark each as required,
   optional, or forbidden.
5. **Context:** What history, retrieved data, system instructions, and tool
   results must be transferred? What may not be retained or sent?
6. **Operational targets:** Maximum latency, token/payload limits, concurrency,
   and whether partial streaming is useful.
7. **Cost target:** Per-request or monthly budget, token ceiling, and whether a
   cheaper documented fallback is acceptable.
8. **Privacy and authorization:** Data classification, retention expectations,
   tenant/user isolation, consent, and which server-owned actions the user may
   authorize.
9. **Fallback expectations:** May the product retry, refresh the catalogue, use
   another registered model, degrade from streaming to non-streaming, or ask the
   user to retry? Define what must instead fail closed.

Record the answers as the route's input/output contract. If a required field is
unknown, ask for it or stop with a clear configuration error; do not infer
permission, privacy suitability, or capability from the model name. Filter the
registry using the required fields, verify live availability, select an exact
model ID, and re-check the selected endpoint's supported parameters immediately
before the call. A fallback is a separately verified registry choice, not an
implicit substitution.

## 2. Choose the integration layer first

Before installing an SDK or writing a direct Poe call, inspect the repository
for an existing provider abstraction. Search for names such as `ai`,
`providers`, `llm`, `inference`, `getClient`, or `complete`, and look for
service factories, model registries, retry/caching helpers, and error types.
Read the local usage and tests before choosing an implementation.

Use an existing provider/client abstraction when one is present. Add Poe as a
provider behind that boundary instead of bypassing it from a route or browser
component. This preserves the app's existing authentication, retries,
telemetry, caching, rate limits, and error contract, and prevents multiple
clients from handling the same secret differently.

Only use the raw OpenAI-compatible SDK or REST fallback below when no suitable
abstraction exists, or when the abstraction explicitly delegates client
creation to it. Do not install a second SDK or create a second provider
singleton merely because a route needs a new model capability.

## 3. Maintain a model capability and routing registry

Treat the registry as application configuration with an owner and verification
record, not as a permanent copy of Poe's catalogue. Keep two related records
when useful:

- The **capability registry** says what an exact model/endpoint combination was
  observed and verified to support.
- The **use-case routing record** says which verified entries are eligible for a
  particular use case, in priority order, with explicit fallback behavior.

### Capability registry contract

Every row must use the exact model ID returned by Poe and identify the endpoint
whose behavior was verified. The row must contain at least:

| Field | Required meaning |
| --- | --- |
| Exact identity | `model.id` copied verbatim, provider, endpoint, and any version/revision label supplied by the provider |
| Live availability | Last `GET /v1/models` observation, availability status, and whether a fresh lookup is required before use |
| Verified inputs/outputs | Accepted input modalities and MIME types, output forms, maximum tested payloads, and response extraction path |
| Capabilities | Vision, tools, structured JSON Schema output, reasoning, streaming, multi-turn/state behavior; each is `yes`, `no`, or `unknown` with evidence |
| Limits | Context, input/output tokens, image dimensions/bytes, tool turns, concurrency, timeout, and request-size limits |
| Parameters | Supported optional fields, rejected fields, defaults, and provider-specific constraints; do not copy unsupported fields |
| Cost and latency | Current documented or observed cost basis, budget class, latency target/observations, and date; never a permanent price claim |
| Privacy suitability | Allowed data classification, retention/processing notes, user/tenant restrictions, and authorization requirements |
| REST mapping | `POST /v1/chat/completions`, `POST /v1/responses`, or another currently documented endpoint and its request shape |
| Validation | Request/response schema, output limits, tool-argument validation, and test evidence |
| Reliability | Retry class, timeout, cancellation behavior, rate-limit handling, cache eligibility, and safe normalized errors |
| Fallback | Explicit eligible model/endpoint, allowed degradation, and fail-closed condition |
| Approved use | Named route/use-case classes and prohibited uses |
| Ownership | Registry owner, verification owner, verification date, source links/notes, and next review trigger |

Never turn `unknown` into `yes` because an SDK type or catalogue row has a
similar name. Keep stale rows for audit if needed, but mark them unavailable
until a fresh catalogue lookup and capability check pass.

### Use-case routing record

For each chatbot route, record the intake result, required versus optional
capabilities, privacy class, budget/latency target, primary registry key,
ordered fallbacks, permitted degradation, and the owner who can change routing.
The route must reject a model that is available but does not satisfy a required
capability. Do not use the presence of a model in the catalogue as proof that
inference, vision, tools, structured output, or streaming works for that model.

## 4. Store the API key as a Replit Secret

1. Open the **Secrets** panel in the Replit workspace.
2. Add a secret named **`POE_API_KEY2`** and paste the key as its value.
3. Read it only in server-side code as `process.env.POE_API_KEY2`.

Never hard-code the key, commit it, include it in a client bundle, put it in
browser local storage, or return it in an error/log response. Do not ask a user
to paste a secret into chat. If the app already uses a secret-management or
provider configuration layer, follow that layer's naming and validation
conventions instead of exposing the key to application code.

## 5. Raw SDK fallback

If no provider abstraction exists, install the standard OpenAI Node SDK from
the app's package manager:

```bash
pnpm add openai
```

Construct it lazily and memoize it in a server-only module. Importing the module
must not read or validate optional Poe configuration, construct a client, or
throw because Poe is not configured. Fail with a clear configuration error at
the operation boundary when Poe is first used. If Poe is required for the whole
service, an explicit startup preflight may call the same getter and fail startup;
that preflight is an application decision, not a module-import side effect.

```ts
import OpenAI from "openai";

let poeClient: OpenAI | undefined;

export function getPoeClient(): OpenAI {
  if (poeClient) return poeClient;

  const apiKey = process.env.POE_API_KEY2;
  if (!apiKey) {
    throw new Error("POE_API_KEY2 is not configured on the server");
  }

  poeClient = new OpenAI({
    apiKey,
    baseURL: "https://api.poe.com/v1",
    timeout: 30_000,
  });
  return poeClient;
}
```

Keep client construction, timeout defaults, and provider-specific error
classification in one module. Routes should call the provider boundary, not
reconstruct clients or read secrets themselves. The memoized getter makes
unrelated imports and server startup safe when Poe is optional while preserving
one client per process after the first Poe operation.

The OpenAI SDK in this guide is a caller for Poe's OpenAI-compatible `/v1`
surface. Do not set its `baseURL` to `https://api.poe.com/bot/` or append
OpenAI routes to `/bot/`. The legacy `/bot/` paths use Poe's bot-server protocol
and SSE envelopes; they are for implementing a bot server that Poe calls, not
for calling Poe models through the OpenAI SDK.

## 6. Discover live model IDs and capabilities

The live `GET https://api.poe.com/v1/models` response is authoritative for the
model IDs currently exposed to the key. Query it server-side for setup and
model-picker workflows and refresh it with a short server-side cache when
appropriate. Use the response as an availability input, not as proof of every
inference capability.

### Bound discovery and capability probing

Make exactly one catalogue request per setup or refresh operation. `GET
/v1/models` returns the available catalogue; do not repeat that request once for
each returned model. Cache a successful catalogue response briefly when several
setup steps or model-picker requests would otherwise fetch the same data.

Do not capability-probe every model in the catalogue. After the single catalogue
lookup:

1. Filter models using the route's required input, output, privacy, cost, and
   operational constraints.
2. Select one primary model and only the explicitly configured fallback models.
3. Run the smallest safe capability probe only for those selected models when
   current validated catalogue metadata and documentation are insufficient.
4. Record untested capabilities and unselected models as `unknown`; `unknown`
   is valid registry state and is not a reason to issue another provider call.

An installation or health check must not fan out into one request per available
model. Do not infer that the capability registry must be fully populated during
installation. Expand it lazily when a model becomes a real routing candidate.
If probing is necessary, bound its model count, concurrency, timeout, retry
policy, and cost before issuing any inference request.

```ts
const response = await fetch("https://api.poe.com/v1/models", {
  method: "GET",
  headers: {
    Authorization: `Bearer ${process.env.POE_API_KEY2}`,
    Accept: "application/json",
  },
  signal,
});

if (!response.ok) {
  throw normalizePoeHttpError(response);
}

const body: unknown = await response.json();
const models = parseModelsResponse(body).map((model) => ({
  id: model.id,
}));
```

The standard OpenAI SDK equivalent is:

```ts
const modelsPage = await getPoeClient().models.list();
const models = modelsPage.data.map((model) => ({ id: model.id }));
```

Validate the response shape before using it. Send every returned `id` verbatim:
do not normalize case, infer aliases, add a provider prefix, or assume that an
ID from an old example still exists. If the live payload includes extra
capability fields, parse and validate those fields into the app's registry
schema. If it does not, consult current Poe documentation and, only for the
selected primary or explicitly configured fallback models, run the smallest
safe capability probe or configured inference check. Do not probe every
returned model. Leave untested capabilities as `unknown`; an SDK `Model` type
and a catalogue response do not guarantee provider-specific metadata or
inference.

Examples must use placeholders such as `<LIVE_MODEL_ID>` and must be labeled
illustrative. Do not put a named model, price, capability, or availability in
production defaults unless the live registry and current documentation have
verified it. A successful catalogue request proves only that the key can access
the catalogue at that moment.

## 7. Use the correct server-side REST endpoint

All Poe calls require server-side Bearer authentication:

```http
Authorization: Bearer <server-side-secret>
Content-Type: application/json
Accept: application/json
```

Never put the Bearer value in browser code, a URL, a client-visible error, a
telemetry field, or a source-controlled example. Authenticate and authorize
the app user before the upstream request. Resolve `<LIVE_MODEL_ID>` from the
live catalogue/registry and verify optional parameters against the selected
model's current capability row and Poe documentation.

### Chat Completions

Use `POST https://api.poe.com/v1/chat/completions` for a chat message sequence
when the selected model and registry row support the requested message content,
parameters, and output form:

```ts
const upstream = await fetch("https://api.poe.com/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.POE_API_KEY2}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    model: "<LIVE_MODEL_ID>",
    messages: [
      { role: "system", content: "Be concise and factual." },
      { role: "user", content: validatedUserMessage },
    ],
    max_tokens: 1024,
  }),
  signal,
});

const payload: unknown = await readPoeJson(upstream);
const reply = parseChatCompletion(payload).choices[0]?.message?.content ?? "";
```

Validate the request locally, reject unsupported optional fields before sending
them, verify the response shape and content limits, and treat the extracted
message as untrusted data. Do not assume every model accepts every Chat
Completions parameter.

### Responses

Use `POST https://api.poe.com/v1/responses` only when the current Poe
documentation and the selected capability row verify that the model supports
the Responses endpoint and the requested input, output, tools, or state shape:

```ts
const upstream = await fetch("https://api.poe.com/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.POE_API_KEY2}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    model: "<LIVE_MODEL_ID>",
    instructions: "Return only the requested answer.",
    input: validatedInput,
    max_output_tokens: 1024,
  }),
  signal,
});

const payload: unknown = await readPoeJson(upstream);
const answer = parseResponse(payload).output_text;
```

Do not infer that a Responses object, response ID, or conversation-like field
creates portable shared state. Store only the application-approved context and
reconstruct it explicitly when needed.

### Structured JSON Schema output

For a model and endpoint whose registry row says structured output is supported,
request a small schema and validate the decoded result with the app's runtime
schema validator:

```ts
const upstream = await fetch("https://api.poe.com/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.POE_API_KEY2}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    model: "<LIVE_MODEL_ID>",
    input: validatedInput,
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    },
  }),
  signal,
});

const payload: unknown = await readPoeJson(upstream);
const value = answerSchema.parse(parseResponse(payload).output_text);
```

Use the currently documented field name and schema shape for the selected
endpoint; some models or API surfaces may support a different structured-output
form. Reject malformed JSON, missing fields, extra fields where relevant, and
values outside business limits. If structured output is unsupported, use only a
documented fallback or return a normalized unsupported-capability error. Never
silently parse arbitrary prose as JSON.

### Tool calling

Declare only server-owned, allow-listed operations with strict JSON schemas:

```ts
const requestBody = {
  model: "<LIVE_MODEL_ID>",
  input: validatedInput,
  tools: [
    {
      type: "function",
      name: "lookup_record",
      description: "Look up an authorized record by its opaque ID.",
      parameters: {
        type: "object",
        properties: { record_id: { type: "string", maxLength: 128 } },
        required: ["record_id"],
        additionalProperties: false,
      },
    },
  ],
};
```

The exact tool envelope differs by endpoint and must match current Poe
documentation and the registry row. Treat a model tool call as a request for
work, not proof that work succeeded: validate every argument, authorize the
user again at execution time, enforce a maximum number of tool turns, execute
only the allow-listed operation, bound and validate its result, and send the
result back as data before continuing the model turn. If the endpoint/model
lacks tool support, return a clear capability error.

Never let a model choose arbitrary URLs, SQL, shell commands, file paths, or
credentials. Log tool name and outcome, not secrets or unrestricted arguments.

### Multimodal input

For a vision-capable model, validate MIME type, dimensions, byte size, and
content before creating the provider-specific image input. For Chat
Completions, the documented shape may resemble:

```ts
{
  role: "user",
  content: [
    { type: "text", text: validatedPrompt },
    {
      type: "image_url",
      image_url: { url: validatedDataUrl },
    },
  ],
}
```

Use the exact current shape for the selected endpoint; do not assume that an
image field accepted by one API surface is accepted by another. Keep decoding
and provider calls on the server, limit dimensions/bytes, reject untrusted
remote URLs unless the app has an explicit safe fetch policy, and do not
persist images or prompts unless the user-facing product requires it. Redact
image-derived personal data from telemetry where possible.

### Streaming and SSE

Set `stream: true` only when the capability row and current documentation
confirm streaming for the selected endpoint/model. For an SSE response, parse
complete `data:` events, tolerate provider event variants, validate each
increment before forwarding, and never pass raw provider errors to the client.
The provider's terminal event and the app's terminal event are separate
contracts; emit the app's documented `[DONE]` marker only after cleanup has
started and the response can be closed safely.

The portable Express-style lifecycle pattern is:

```ts
app.post("/chat/stream", async (req, res) => {
  const controller = new AbortController();
  let clientGone = false;
  let sentDone = false;

  const writeEvent = (event: unknown) => {
    if (!clientGone && !res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  const finish = () => {
    if (!sentDone && !clientGone && !res.destroyed && !res.writableEnded) {
      sentDone = true;
      res.write("data: [DONE]\n\n");
    }
    if (!res.destroyed && !res.writableEnded) res.end();
  };
  const onRequestAborted = () => {
    clientGone = true;
    controller.abort();
  };
  const onResponseClose = () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  };

  req.once("aborted", onRequestAborted);
  res.once("close", onResponseClose);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    // Authenticate, validate req.body, check the registry, and apply
    // rate limits before this call.
    const streamResponse = await fetch(
      "https://api.poe.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.POE_API_KEY2}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "<LIVE_MODEL_ID>",
          messages: validatedMessages,
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    if (!streamResponse.ok || !streamResponse.body) {
      throw normalizePoeHttpError(streamResponse);
    }

    for await (const event of parseSse(streamResponse.body)) {
      if (clientGone) break;
      const safeEvent = parseAndValidatePoeStreamEvent(event);
      if (safeEvent.delta) writeEvent({ delta: safeEvent.delta });
    }
  } catch (error) {
    const normalized = normalizePoeError(error);
    if (!res.headersSent && !clientGone) {
      res.status(normalized.status).json(normalized.body);
      return;
    }
    if (!clientGone) writeEvent({ error: normalized.body });
  } finally {
    req.removeListener("aborted", onRequestAborted);
    res.removeListener("close", onResponseClose);
    controller.abort();
    finish();
  }
});
```

In real code, `parseSse`, response validators, and error normalizers must
handle buffering, event boundaries, provider event variants, and safe limits.
If headers are already sent, preserve SSE framing and the safe error code; do
not attempt to change the status. If a disconnect has occurred, cleanup
silently and do not write. For non-Express servers, implement equivalent abort,
listener cleanup, and guaranteed close behavior.

## 8. Reconstruct context when switching models

Models do not share hidden memory, provider conversation state, or portable
response state unless the current endpoint explicitly documents such behavior
and the application has chosen to use it. Never pass an opaque response ID or
assume one model can dereference another model's state.

When routing or falling back to another model:

1. Stop the old attempt or mark it cancelled; do not let late output overwrite
   the new result.
2. Rebuild a bounded context package from application-owned state: system
   instructions, relevant user turns, validated assistant output, retrieved
   facts with provenance, and approved tool results.
3. Re-apply the destination model's input, privacy, token, and capability
   constraints. Convert content explicitly rather than silently dropping
   images, tools, schema requirements, or citations.
4. Identify the destination model and context transfer in telemetry without
   recording secrets or unnecessary prompt contents.
5. Validate the destination response against the same user-facing contract,
   or apply an explicitly documented degraded contract and tell the caller.

Do not copy untrusted model text into system instructions, tool authorization,
or SQL/shell/file arguments. Context reconstruction is a data boundary and
must be treated as untrusted-input processing.

## 9. Reliability, privacy, and cost controls

Apply these controls in the provider abstraction, not independently in every
route:

- **Retries:** Retry only transient network failures, timeouts, selected 5xx
  responses, and provider rate limits. Use a small bounded attempt count,
  exponential backoff, and jitter. Honor `Retry-After` when present. Never
  retry invalid authentication, exhausted quota, invalid requests, or a
  permanently unavailable model. A retry must reuse a safe idempotency policy
  and must not duplicate an irreversible tool operation.
- **Timeouts and cancellation:** Give every upstream call a deadline. Connect
  request abort/disconnect signals to the provider request and release all
  listeners and timers in cleanup code. Abort stale attempts when routing
  switches models.
- **Caching:** Cache only deterministic, idempotent results where the product
  permits it. Include exact model ID, endpoint, relevant input, tenant/user
  scope, tool/schema version, context and prompt version, and capability mode
  in the key; use a TTL and bounded storage. Do not cache private data across
  users, failed responses, credentials, or unbounded prompts. Invalidate when
  model or prompt behavior changes.
- **Usage telemetry:** Record model, endpoint, route/use case, latency, status,
  retry count, cache hit, fallback transition, and provider-reported token
  usage when available. Apply retention and access controls, and omit API keys,
  full prompts, image bytes, tool secrets, and unnecessary personal data.
- **Rate limits and backpressure:** Authenticate before expensive work, apply
  per-user/tenant and global limits before calling Poe, bound concurrent
  upstream requests, and return a retryable 429 with safe headers when limits
  are reached. Do not rely on Poe's limit as the app's abuse protection.
- **Output validation:** Validate every non-streaming response, structured
  object, tool argument/result, multimodal extraction, and stream event against
  the app's runtime contract before use or forwarding. Bound output size and
  tool turns.
- **Privacy:** Route only data permitted by the intake's privacy class. Do not
  persist prompts, images, or model output beyond the product's stated need.
  Separate tenants/users in storage, cache keys, logs, and authorization.
- **Normalized errors:** Map provider failures to a small app contract such as
  `unauthorized`, `quota_exhausted`, `rate_limited`, `model_unavailable`,
  `unsupported_capability`, `invalid_request`, `upstream_timeout`, and
  `upstream_error`. Give clients a stable code and safe message; keep provider
  request IDs and stack details in protected server logs only.

## 10. Key health-check

Use a server-only health/setup check to validate configuration. Invoke it from
an explicit setup action or startup preflight, never as a module-import side
effect. A successful
`GET /v1/models` proves that the key can access the catalogue at that moment;
it does not prove that a particular model, capability, quota, or inference
request will succeed. The health check makes one catalogue request regardless
of how many models are returned. It must not trigger per-model inference probes.

```ts
type PoeKeyStatus =
  | "valid"
  | "rejected"
  | "quota_exceeded"
  | "rate_limited"
  | "unavailable"
  | "unknown";

async function checkPoeKey(apiKey: string): Promise<PoeKeyStatus> {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.poe.com/v1",
    timeout: 5_000,
  });
  try {
    await client.models.list();
    return "valid";
  } catch (error: unknown) {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401 || error.status === 403) return "rejected";
      if (error.status === 402) return "quota_exceeded";
      if (error.status === 429) return "rate_limited";
      if (error.status === 500 || error.status === 502 ||
          error.status === 503 || error.status === 504) return "unavailable";
    }
    // A timeout or network outage is not proof that a configured key is bad.
    return "unknown";
  }
}
```

Do not log the key or raw error body. A setup UI can fail closed when a
definitive 401/403 or quota response is returned, but should distinguish an
outage from a rejected key. If the app uses a provider abstraction, call its
health-check and preserve its normalized result instead of constructing a
second client.

## 11. Failure modes and explicit fallback

| Scenario | Safe handling |
| --- | --- |
| Missing secret | Fail at the first Poe operation or an explicit startup preflight with a configuration error. Importing an optional Poe module must remain safe; never send the key or secret value to the client. |
| 401/403 | Report `unauthorized` and require server configuration repair; do not retry. |
| 402 or exhausted allowance | Report `quota_exhausted`; do not retry automatically. |
| 429 | Apply bounded backoff for eligible upstream calls, respect `Retry-After`, and expose a stable rate-limit response. |
| Timeout/network/5xx | Abort and retry only within a bounded transient policy; then report `upstream_timeout` or `upstream_error`. |
| Invalid request/schema/tool arguments | Return a 400-class contract error after local validation; do not retry unchanged input. |
| Model unavailable/retired | Refresh the live catalogue and return `model_unavailable`; do not silently substitute a different model unless the route's routing record explicitly allows the verified fallback. |
| Unsupported capability/parameter/endpoint | Return `unsupported_capability` or choose the documented verified fallback; never pretend structured output, tools, vision, Responses, or streaming succeeded. |
| Catalogue succeeds but inference fails | Keep the key/catalogue status separate from model capability or quota status; normalize the inference failure and update the registry evidence if appropriate. |
| Browser CORS attempt | Keep Poe calls server-side. The browser calls the app's authenticated route, not `api.poe.com`. |
| Client disconnect during stream | Abort upstream work, remove listeners, avoid writes, and close/settle resources. |
| Model switch during a request | Cancel the stale attempt, reconstruct context explicitly, and prevent late output from winning. |

A fallback must be selected from a live-available, capability-verified registry
row and must satisfy the intake's privacy and output contract. If no such row
exists, fail clearly rather than silently changing the user's requested
behavior.

## 12. Generic new-route checklist

For every route that calls Poe, check all of the following:

- [ ] Intake records goal, input, output, required capabilities, context,
      latency, cost, privacy, authorization, and fallback expectations.
- [ ] An existing provider abstraction was searched for and reused when
      available; no duplicate client or direct provider call was added.
- [ ] Poe is called only from server-side code; the API key and provider
      details cannot reach client bundles or browser logs.
- [ ] Optional Poe modules are import-safe: secret validation and memoized client
      construction happen only when a Poe operation runs.
- [ ] Any startup failure comes from an explicit application preflight, not an
      import-time side effect.
- [ ] Authentication and authorization happen before model work, including
      authorization of each server-side tool operation.
- [ ] Per-user/tenant and global rate limits, concurrency bounds, and request
      deadlines are applied before the upstream call.
- [ ] The exact model ID came from a live catalogue lookup and the capability
      registry identifies the endpoint, verified parameters, limits, cost,
      privacy suitability, fallback, verification date, and owner.
- [ ] `GET /v1/models` availability is not being treated as proof of inference
      or optional capability support.
- [ ] Setup performs one catalogue lookup, filters candidates, and probes only
      the selected primary and explicit fallbacks; all other capabilities remain
      `unknown`.
- [ ] Chat Completions versus Responses was selected from current endpoint and
      model support; unsupported optional fields are rejected before sending.
- [ ] Request and response contracts are documented in the app's existing
      schema/API mechanism and runtime validation rejects untrusted output.
- [ ] Context is rebuilt explicitly when switching models; no shared hidden
      memory or portable response state is assumed.
- [ ] Retries, caching, telemetry, abort handling, and normalized errors use
      shared provider policies rather than route-specific copies.
- [ ] Streaming handles SSE parsing, upstream failure, client disconnect,
      cancellation, cleanup, and guaranteed response termination.
- [ ] Unit tests cover validation, auth/rate limits, model discovery, endpoint
      selection, provider success, each relevant normalized failure,
      cache/telemetry behavior, context reconstruction, and stream cleanup.
- [ ] An end-to-end test exercises the authenticated browser-to-route contract
      when the feature is user-visible; provider calls are safely stubbed.
- [ ] Logs and metrics include route/use case, model, endpoint, latency, status,
      retries, fallback, and usage without prompts, images, secrets, or
      unnecessary PII.
- [ ] The route is tested with missing configuration and provider outages, and
      operational alerts or dashboards have been considered.

## Quick-start checklist

- [ ] Completed the intake before selecting a model or endpoint.
- [ ] Searched for and understood an existing provider/client abstraction.
- [ ] `POE_API_KEY2` is in Replit Secrets or is managed by the existing provider.
- [ ] All provider calls stay server-side and use Bearer authentication.
- [ ] Raw SDK fallback lazily memoizes one server client at
      `https://api.poe.com/v1`; it never composes OpenAI SDK routes with the
      legacy bot-server `/bot/` protocol.
- [ ] `GET /v1/models` supplies exact IDs; no stale example is a production
      default, and catalogue access is not treated as inference proof.
- [ ] Setup makes one catalogue request and does not fan out across every model;
      capability probes are limited to the selected primary and explicit
      fallbacks.
- [ ] The selected registry row verifies endpoint, inputs, outputs, capabilities,
      limits, parameters, cost, privacy, validation, fallback, and ownership.
- [ ] Chat Completions versus Responses is supported by the live/current
      endpoint documentation for the exact model.
- [ ] Request/output schemas, tools, and vision inputs are validated.
- [ ] Model switches reconstruct approved context explicitly.
- [ ] Timeouts, bounded retries, cancellation, cache scope, usage telemetry,
      privacy controls, and rate limits are implemented at the provider boundary.
- [ ] Error responses are normalized and safe.
- [ ] Streaming routes parse SSE and terminate on success, failure, and
      disconnect.
- [ ] Unit and relevant end-to-end coverage is in place.

---
