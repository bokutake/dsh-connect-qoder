# Troubleshooting

> This document is about "you hit this error, now what". The plugin's **scope**, installation
> and configuration live in [`README.en.md`](../README.en.md); design trade-offs and the
> evidence behind them in [`DESIGN.md`](DESIGN.md); changes per version in
> [`CHANGELOG.md`](../CHANGELOG.md).

## First, is the failure about **this request**, or about **the account / the upstream**?

This decides what you should do next, and getting it backwards is the most common mistake
around this repository:

| What you see | What it actually is | What to do |
| --- | --- | --- |
| `401` / `invalid_api_key` | the PAT was refused (business code `105`) | replace the PAT, or check that region's PAT under Settings → Qoder |
| `429` / `quota_exceeded` | out of quota (`110`/`113`/`144`/`147` and the rest of the quota family) | top up or switch model; **replacing the PAT does nothing** |
| `429` / `rate_limit_exceeded` | rate limited (a short HTTP 429 window) | wait; it recovers by itself |
| `400` / `content_policy_rejected` | content moderation refusal | change the input; **another account will not help** |
| `502` / `upstream_error` | a transient upstream fault, **or a content refusal** (next section) | read the next section first |

## 1. `403 + 10605 / RESOURCE_LIMIT` can be a **content** refusal, not rate limiting (issue #2)

### Symptom

Nothing goes through. The envelope in the log or the UI looks like this:

```
HTTP 403 {"code":"10605","message":"{\"isQueued\":true,\"queueCount\":0,\"queueType\":\"p2\",
  \"retryAfterSeconds\":30,\"serviceAvailable\":false,\"subCode\":\"RESOURCE_LIMIT\"}"}
```

Replacing the PAT, switching accounts, waiting out the cooldown and clearing rate-limit windows
**all do nothing**. Changing one suspicious whole sentence in the prompt makes it work.

### The known trigger

The whole `harness:identity` sentence in DSH's default system prompt (`includeHarnessIdentity`
is on by default):

```
You are an AI agent powered by DeepSeek Harness.
```

**Measured locally (2026-11, 3 rounds / 10 real requests, model `dfmodel`)**:

| system content | Result |
| --- | --- |
| `You are an AI agent powered by DeepSeek Harness.` | **403 / 10605 / `serviceAvailable:false` (3/3)** |
| the same sentence with `agent` changed to `assistant` | works |
| **no system message at all** | works |
| 30 000 characters of `z` filler | works |

Every individual word passes; only the whole sentence fails. `DeepSeek Harness` on its own also
passes — so this looks like an **exact whole-sentence fingerprint** (recognising a known agent
boilerplate), not general content moderation.

### Why the plugin does not handle it for you

**Because the two causes share one envelope and cannot be told apart from its fields.** Issue #29
in this repository was a genuine outage, and its envelope is **byte-for-byte identical** to the
one above:

```
{"isQueued":true,"queueCount":0,"queueType":"p3","retryAfterSeconds":30,
 "serviceAvailable":false,"subCode":"RESOURCE_LIMIT"}
```

The evidence in #29 was "the plugin's own probe failed on all 14 models". That probe carries
**no system message** — so a probe failure means the upstream really is refusing everyone.

Reclassifying `10605` as content-policy would turn genuine rate limiting / outages into "do not
record the account, do not cool down, do not fail over", so every request would hammer the same
wall with no backoff. **Rewriting every request's system prompt is also outside a provider's
job** — it would affect every conversation you have.

### How to tell that this is the cause

- **every** session fails, not intermittently and not only on one model;
- a request with **no system message** works (the plugin's probe has that shape — the pool's
  "test" / "test all accounts" actions use exactly it);
- turning `includeHarnessIdentity` off fixes it immediately.

> ⚠️ **"Try a new conversation" is not a valid test** — the sentence is injected into **every**
> DSH session, so a new one fails the same way.

### Workaround

Turn that sentence off in the profile's `cordis.patch.yml` and add your own identity line via
`personaPrefix`, then **restart that profile's host process**:

```yaml
- id: system-prompt
  name: "@deepseek-ai/dsh-system-prompt"
  config:
    includeHarnessIdentity: false
    personaPrefix: "You are a helpful software engineer assistant."
```

`id: system-prompt` is the host's own entry id; DSH's bundled `dsh-sdk-minimal` uses exactly
this shape, so you can compare against it.

### Why there is no plugin option to "replace the identity text"

The text of `harness:identity` has **no** exposed config — only on/off (`includeHarnessIdentity`).
Registering a same-named section at **global** scope is rejected by the host:

```
prompt section "harness:identity" is already registered
  (for a per-agent override, register through that agent's `agent.ctx` instead)
```

Only a **per-agent scope** (agent preset / subagent) may shadow that slot. `personaPrefix` is
the officially provided, free-form cell — so the available move is "turn it off and add your
own", not "rewrite it in place".

## 2. `401` / "invalid API key" but the PAT is fine

The upstream answers HTTP 403 for the **quota family** (daily limit, a dedicated credit package
running out, …). When a business code is missing from the code table the plugin can only guess
from the status, so the host renders "invalid API key" — while what you actually need is a
top-up or another model. These codes have been added one by one (`110`/`112`/`113`/`144`/`147`
and friends).

If you still see this, paste the upstream error **verbatim** from the Diagnostics column,
together with `modelKey` — the business code is inside that string.

## 3. `NO_ADAPTER`

The model that conversation had selected belongs to a provider you **turned off**. Re-check that
region under Settings → Qoder, or pick another model. Turning a provider off **removes it
entirely** from the picker (it does not merely hide a tab), but the PAT, usage data and model
selections are all kept.

## 4. The CLI reports `Cannot find package '@deepseek-ai/dsh-atomic-write'`

The standalone CLI depends on host-provided peer packages. pnpm usually installs them into the
profile's dependency tree; when it does not, you get this error. **Provider registration, the
settings page and chat are unaffected** (they run inside the host). Work around it by using the
in-host path, or check pnpm's `auto-install-peers` setting.

## 5. Queueing is slow, or "the upstream is not serving"

The same `isQueued: true` has two shapes, with completely different handling:

| Upstream fields | Meaning | What to do |
| --- | --- | --- |
| `isQueued:true` + `serviceAvailable:true` | the service is fine, you are in the queue | wait, or switch accounts (effective) |
| `isQueued:true` + `serviceAvailable:false` | the upstream is refusing **everyone** (`queueCount` is often 0) | wait; **switching accounts or PATs does nothing** |

Within `queueWaitMs` the plugin waits out the delay the upstream asked for by itself (the retry
budget cannot cover this; see the retry-budget section in the README).

## 6. No per-model consumption rows in the Qoder billing console

1.28.0 fixed two root causes: `business` records are now **one record per user input**, and each
turn closes with `business/finish`. After the fix, per-model rows do appear in the console in
local testing.

**Still unverified**: whether `Billing daily count exceeded` can still occur. The daily counter
is not exposed, and the quota was never driven to its limit, so **there is no measured conclusion
here** — do not read this as "fixed".
