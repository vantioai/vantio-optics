# @vantio/agent-sdk

**Vantio** is the infrastructure control layer for autonomous AI. This package is **Vantio Optics** Observe for Node: a trace ID around your agent. It does not wrap `fetch` by itself — Node wrap lives in [`@vantio/cli`](https://www.npmjs.com/package/@vantio/cli) (`vantio run`).

Optics does not block on its own. [Phantom Engine](https://github.com/vantioai/vantio-phantom-engine) enforces rules on the wrapped path and provides runtime protection on enrolled Linux — Observe, Enforce, and Control in one purchase.

```bash
npm install @vantio/agent-sdk@0.2.4
```

## Quick start

```ts
import { shield } from "@vantio/agent-sdk";

await shield(async () => {
  await runMyLLMAgent();
});
```

Wrap your agent in `shield()`. Vantio generates a trace ID and propagates it through async hops — without reading your prompts. Node LLM wrap (fetch, undici, http/https, …) is `vantio run` from `@vantio/cli`, not this package.

---

## API

### `shield(callback, options?)` — trace context

```ts
import { shield } from "@vantio/agent-sdk";

const result = await shield(async () => {
  return await runMyAgent();
});

// With options:
await shield(async () => { ... }, {
  traceId: "custom-uuid",   // optional — generated if omitted
});
```

`withVantio()` is an alias for `shield()` — use either.

---

### `reportAnomaly(event, opts?)` — send metadata to Phantom Engine ingest

Scope: this API is part of Vantio Phantom Engine / Enterprise and requires a separately provisioned control-plane key. It is not part of free Vantio Optics, which runs local-first with no account and no API key.

```ts
import { shield, reportAnomaly } from "@vantio/agent-sdk";

await shield(async () => {
  await runMyAgent();

  await reportAnomaly({
    target_host:   "api.openai.com",
    bytes_severed: 14382,
    // VantioActionTaken: "OBSERVED" | "ALLOWED" | "REDACTED" | "BLOCKED_HOST" | "BLOCKED_SIZE" | "BLOCKED_SPEND"
    action_taken:  "BLOCKED_HOST",
    pid:           process.pid,
  });
});
```

It sends only when an ingest URL is set: pass `ingestUrl`, or set `VANTIO_INGEST_URL` together with `VANTIO_CLOUD_INGEST=true`. With neither, it does nothing. It sends `VANTIO_API_KEY` (or `VANTIO_IDENTITY`) in the `x-vantio-identity` header, or `"unknown"` when neither is set. It refuses plain `http://` to another machine: use `https://`, or `http://` only to `localhost`, `127.0.0.1` or `::1`. Non-fatal: a failed or refused send only logs a warning.

---

## Policy & redaction (Vantio Phantom Engine)

The SDK does not load or apply a policy. Vantio is not a network proxy.

### `fetchPolicy(apiKey, opts?)` — returns the default policy

Scope: this API is part of Vantio Phantom Engine / Enterprise and requires a separately provisioned control-plane key. It is not part of free Vantio Optics, which runs local-first with no account and no API key.

```ts
import { fetchPolicy, type VantioPolicy } from "@vantio/agent-sdk";

const policy: VantioPolicy = await fetchPolicy(process.env.VANTIO_API_KEY!);
// { enforce, redact_pii, pii_types, allowed_hosts,
//   blocked_hosts, max_request_bytes, spend_cap_usd }
```

It makes no request and does not send the key. It logs a warning and returns a copy of `DEFAULT_POLICY` with `enforce` and `redact_pii` false. The options (`ingestUrl`, `timeoutMs`, `signal`) are accepted and not used.

### `redactPII(text, piiTypes?)` — strip PII locally

```ts
import { redactPII } from "@vantio/agent-sdk";

const { text, redactions } = redactPII("ssn 123-45-6789, mail a@b.com");
// text       → "ssn [VANTIO_REDACTED:SSN], mail [VANTIO_REDACTED:EMAIL]"
// redactions → ["ssn", "email"]
```

A pure, side-effect-free function — **nothing ever leaves your process.** Supports `ssn`, `email`, `credit_card`, and `phone` (defaults to all four), using the same patterns and `[VANTIO_REDACTED:LABEL]` tokens as the CLI interceptor.

The `VantioActionTaken` union (`"OBSERVED" | "ALLOWED" | "REDACTED" | "BLOCKED_HOST" | "BLOCKED_SIZE" | "BLOCKED_SPEND"`) is also exported for typing your own enforcement reporting.

---

### `getCurrentTraceId()` — read the active trace ID

```ts
import { getCurrentTraceId } from "@vantio/agent-sdk";

await shield(async () => {
  const id = getCurrentTraceId(); // always defined inside shield()
  console.log(`Trace: ${id}`);
});

getCurrentTraceId(); // undefined — outside shield() frame
```

---

## Environment variables

Scope: this API is part of Vantio Phantom Engine / Enterprise and requires a separately provisioned control-plane key. It is not part of free Vantio Optics, which runs local-first with no account and no API key.

| Variable | Description |
|---|---|
| `VANTIO_INGEST_URL` | Ingest endpoint (default: `https://vantio.ai`) |
| `VANTIO_CLOUD_INGEST` | Set to `true` to enable cloud routing |
| `VANTIO_AUDIT_MODE` | Set to `1` to flag events as audit mode |

---

## Zero-line Node wrap

No code changes for Node — use the CLI:

```bash
npx @vantio/cli run node agent.js
```

Python needs [`vantio-agent-sdk`](https://pypi.org/project/vantio-agent-sdk) on that interpreter. Prefixing `vantio run python` does not intercept by itself.

---

## What gets captured

- Which LLM endpoint was called
- Response size in bytes
- Process ID and timestamp
- A trace ID linking all calls in the same agent run

**What never gets captured:** prompts, completions, or any content from your requests.

---

[vantio.ai](https://vantio.ai) · [Optics](https://vantio.ai/optics) · [Pricing](https://vantio.ai/pricing) · MIT License
