<p align="center">
  <img src="docs/assets/dsh-connect-qoder-usage-card.png" width="640" alt="dsh-connect-qoder settings page: CN / Global tabs with the account pool, credits, daily check-in and automatic failover" />
</p>

<h1 align="center">dsh-connect-qoder</h1>

<p align="center"><b>Connect Qoder (Lingma CN / international) models to DeepSeek Harness, with an account pool, daily check-in, credit readouts and model management.</b></p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#account-pool">Account pool</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/bokutake/dsh-connect-qoder/issues">Issues</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/%40bokutake%2Fdsh-connect-qoder"><img src="https://img.shields.io/npm/v/%40bokutake%2Fdsh-connect-qoder?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/%40bokutake%2Fdsh-connect-qoder"><img src="https://img.shields.io/npm/d18m/%40bokutake%2Fdsh-connect-qoder?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/bokutake/dsh-connect-qoder/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/bokutake/dsh-connect-qoder/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/bokutake/dsh-connect-qoder?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/bokutake/dsh-connect-qoder/stargazers"><img src="https://img.shields.io/github/stars/bokutake/dsh-connect-qoder?style=flat-square" alt="GitHub stars"></a>
</p>

A standalone [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle plugin. It connects your Qoder account's models to the DSH model picker, with an account pool, daily check-in, credit readouts and model management. **The CN and international editions are two parallel providers (`qoder` / `qoder-global`) that can be used at the same time**; the plugin's settings page separates them with tabs.

## About this repository (an independently maintained fork)

This is an **independent fork** of [`dingminhua/dsh-connect-qoder`](https://github.com/dingminhua/dsh-connect-qoder). Upstream announced end-of-maintenance in [issue #49](https://github.com/dingminhua/dsh-connect-qoder/issues/49), citing Qoder's removal of daily check-in credits for free users.

This fork continues for a different reason, unrelated to the plugin's core purpose: upstream had defects in **billing attribution** (the granularity of `business` records and a missing per-turn closure) and in **device identity** (where the `machineId` / `machineToken` values come from), so **no per-model consumption rows ever appeared in the Qoder billing console**. See the `1.28.0` section of [`CHANGELOG.md`](CHANGELOG.md) for the changes, and [`LICENSE-MODIFICATIONS.md`](LICENSE-MODIFICATIONS.md) for the modification scope and licensing.

**Maintenance model**: best-effort, primarily to support my own usage. Issues and PRs are welcome, but **no maintenance SLA, response-time commitment or feature roadmap is guaranteed** — if you want committed timelines, this may not be your best choice.

> Qoder does not expose an OpenAI-compatible endpoint (its official SDK is only an agent launcher), so this plugin talks to Qoder's cosy gateway directly, implementing a minimal client for the protocol. **No Qoder desktop sign-in is needed** — just a PAT (Personal Access Token).

## Features

- **Two parallel providers (CN + international)** — the CN edition registers as `qoder` (`gateway.qoder.com.cn`), the international one as `qoder-global` (`api1.qoder.sh`). **Only a region with a PAT appears in the DSH model picker**; with both configured they can be used at the same time, each session picking its own side. A region without a PAT lists no models (listing them would only invite failures). Model names embed the upstream credit multiplier, e.g. `Qwen3.8-Flash · x0.00`.

  <img src="docs/assets/dsh-connect-qoder-model-picker.png" width="360" alt="The DSH model picker with the Qoder and Qoder Global groups; each model name carries its credit multiplier" />
- **A settings page of its own (Settings → Qoder)** — one page alongside Accounts & Balance / General / Models / Plugins. The top carries CN / Global tabs, each with its own PAT, models and usage; the body is split into Accounts / Models / Diagnostics, and **switching sections never refetches and never drops an unsaved draft**. Diagnostics is a read-only fact table (upstream domain, serving account, credential source, catalog size, upstream's own last error verbatim) whose only reason to exist is to be quoted into a bug report.
- **Either edition can be switched off on its own** — unchecking removes that provider from the model picker **entirely** (route and directory entries both), keeping the PAT, usage and selections; re-checking restores all of it. A session that had already selected one of its models gets `NO_ADAPTER` on its next call.
- **Model management** — refresh the full catalog from upstream and tick models one by one; each row shows the multiplier, context/output limits, thinking tiers and a free marker, plus Image / Off-able thinking switches, a context-tier selector and a Test button. **The list is as tall as the catalog** (no height cap of its own). Upstream's `auto` is a router rather than a model, so it is not listed; neither are `Fast` / `Ultimate` / `Efficient` (bare adjectives); `Sonus` / `Cantus` are listed (product names, and the two most expensive rows in the catalog, issue #37); the two global-only rows never show up on the CN side. Evidence: [`docs/DESIGN.md`](docs/DESIGN.md).

  <img src="docs/assets/dsh-connect-qoder-model-management.png" width="640" alt="The model management area: per-model multiplier, max context/output, thinking-effort tiers, and the image / off-able-thinking / context-tier controls with a test button" />
- **Promotion badge** — upstream ships the promotion rule inside the catalog itself (label, window, time zone), and each model row paints a capsule at **render time** (e.g. `Off-Peak 60% off`); the label is upstream's own text, neither translated nor rewritten. The same badge also appears in the host's model picker (`LlmModelInfo.badge`, capped at 16 graphemes — a longer label is dropped entirely rather than truncated). Rules: [`docs/PROMO_BADGE.md`](docs/PROMO_BADGE.md).

  <img src="docs/assets/dsh-connect-qoder-promo-badge.png" width="640" alt="The model management area: the Qwen3.8-Max and Qwen3.7-Plus rows each carry a blue capsule after the multiplier and outside the model name, labelled with upstream's own text — 错峰 4 折 and 错峰4折" />
- **Daily check-in (manual / automatic)** — the official campaign: individual users can claim 100 credits a day, valid for 30 days. The pool's "Check in all accounts" claims per account and treats an already-claimed day as idempotent. The optional "check in automatically each day" is controlled by `regions.<region>.pool.autoCheckin` and is **off by default**: its rule is character-for-character the button's — **it reads the campaign status first, and an already-claimed account is only marked, with no claim request** — so a restart, a retry or a duplicated timer cannot claim twice; it rolls over on the window moment upstream states, the official **10:00** (UTC+8) rather than local midnight. Failures back off 30s → 1 → 2 → 5 → 15 minutes, then retry every 30 minutes.
- **Credits and expiry (read-only)** — each account shows remaining credits, **when those credits lapse** and **when the plan ends** (`sash/api/v2/me/usage`, queried with the `jt-` jobToken, **costing no credits**); credits expiring within 3 days are highlighted. **Two expiries are two different things** (issue #31): upstream's `expiresAt` is the **account-level plan / 14-day trial** expiry — exposed as its own field `planExpiresAtMs` and shown separately — not the expiry of any **credit package**, so it takes no part in the expiring highlight or pool ranking; credit expiry comes from **check-in batches** (`validity.days`, 30 days), where `claimAtMs` and the amount are recorded at claim time into the `credits` key of `$DSH_HOME/.qoder-pool.<region>.json`, booked FIFO and **displayed as a pessimistic bound**.
- **Composer credits readout (position is a choice)** — the input area shows `QD CN` / `QD AI` with the serving account's balance; clicking it opens a per-account table where a row click switches accounts, gated by each region's "show credits in the composer" switch (on by default). The position is one of two: **the composer toolbar** or **below the composer** — the former is a shared slot that another plugin can crowd out of sight, in which case switch to the latter. Both surfaces refresh on one global interval (`pollMinutes`, Capabilities tab: 1 / 5 / 10 / 30 / 60 minutes, default 5).

  <img src="docs/assets/dsh-connect-qoder-composer-credits.png" width="360" alt="The composer credit panel: per-account QD CN balances, a Settings button and the last refresh time" />
- **Multi-account pool (PAT)** — one local vault per region (`$DSH_HOME/.qoder-accounts.<region>.json`, 0600) merges the settings PAT, the environment variable and vault accounts, de-duplicated. **Taking an account out of rotation** (untick it in the pool table; the credential stays and can be ticked back) and **deleting** it (erase the PAT from the vault, irrevocable) are two different actions.
- **Probe-ranked selection and automatic failover** — "Test all accounts" sends a real request per pool member and persists results to `$DSH_HOME/.qoder-pool.<region>.json`; with the pool on, the chat stream picks the top-ranked usable account before the first byte (usability → credits expiring soonest → nearest credit expiry → highest credits → id) and walks down the list on failure. **An upstream quota exhaustion is always surfaced** (independent of the pool switch): a quota-family business code makes the region's card show it (time + code, with the redacted text on hover), and with the pool off that notice is the only visible outlet for the failure. Rate limiting (a short-window HTTP 429) **does not** count as exhaustion.
- **Thinking effort and context budgets** — only the tiers upstream **actually declares** are listed (Qwen-family `low/medium/xhigh`, DeepSeek/GLM-family `low/high/max`); a choice is saved and sent with every request, and context tiers likewise come only from `context_config` — no declaration, no control, no invented options. **Upstream's declared default is the picker's default.**
- **Honest model capabilities** — upstream's `is_vl` is a **platform**-level image claim rather than a native model capability (almost every model says `true`), so only a table keyed by exact model id counts: verified models are pre-checked, anything unverified stays unchecked, and the tooltip says why. On 2026-10-29 all **14 models** across both regions' catalogs were sent an image of the digit `7` and asked which digit it was — **all of them read it**.
- **Cache hits reported truthfully** — upstream's `usage.cached_tokens` is passed all the way through to the host, so the GUI's cache-hit figure is a real ratio (it is a **subset** of `prompt_tokens` and never added to the totals); when upstream does not report it, it is omitted rather than replaced with 0. **`session_id` stays stable within a session** (issue #42): Qoder buckets its prompt cache by it, and a fresh random value every turn invalidated the cache 100% of the time.
- **Secure loopback shim** — one random port + in-process random secret per region, so **the PAT never reaches pi-ai**: pi-ai only talks to the local shim, which performs upstream requests with cosy sessions (jobTokens).
- **Account transfer / campaign tiles / CLI diagnostics** — accounts can be exported to a transfer file and imported per region; the card shows a set of read-only **campaign tiles** below the credit readout (switchable per region, `regions.<region>.showCampaigns`); CLI in [CLI diagnostics](#cli-diagnostics). Implementation details: [`docs/DESIGN.md`](docs/DESIGN.md).

## How it works

```text
DSH PiAiAdapter (one set per provider)
  -> secure loopback shim (random port + in-process secret per region)
  -> QoderUpstreamClient (minimal cosy-protocol client)
  -> CN      https://gateway.qoder.com.cn/algo/api/v2/...
  -> Global  https://api1.qoder.sh/algo/api/v2/...
  -> Qoder SSE (OpenAI-shaped deltas)
  -> DSH executes local tools and returns results
```

The CN and international editions each own a full runtime stack — upstream client, model catalog, loopback shim, adapter — isolated by region configuration (gateway / openapi / catalog paths), so **models from both regions can be available at the same time and used by different sessions**.

Credentials are PATs (settings page `regions.<region>.pat`, or environment variables — see [Configuration](#configuration)); the settings value wins. Sessions lazily exchange a **jobToken** on demand: the PAT is used once in that exchange, and every subsequent request carries a cosy bearer (custom Base64 payload + MD5 signature) plus "machine fingerprint" session headers. **The PAT never reaches pi-ai and never leaves the process except in that one local exchange; this plugin neither reads nor writes Qoder desktop sign-in files.**

Encoding and signing details (custom alphabet, `n/3` rearrangement, `cosy&<SECRET>&<date>` signature, RSA/AES session wrapping) are documented at the top of `src/cosy.ts`; the error taxonomy (content policy / rate limit / quota exhausted / transient) and how it maps onto DSH retry semantics live in `src/upstream.ts`.

## Installation

### From a published package (recommended)

```bash
dsh plugin --profile desktop add @bokutake/dsh-connect-qoder   # Desktop
dsh plugin --profile web add @bokutake/dsh-connect-qoder       # Web
```

> **Switching from upstream**: the package name changed from `@dmh2002/dsh-connect-qoder` to
> `@bokutake/dsh-connect-qoder`. Run `dsh plugin remove @dmh2002/dsh-connect-qoder` first, then
> install the new one — they are different package names, so both can coexist, but enabling both
> at once registers the same provider twice. **Your configuration is not lost**: the plugin's
> identity inside DSH is unscoped (see the note below), so the account pool and model selections
> carry over.

Then **restart that profile's DSH process** (the host half of a bundle loads at startup). You can also search for `dsh-connect-qoder` in DSH's "Plugin market / Bundles" and install it in one click.

> **Does `dsh` fail with `Cannot find module .../DSH NEXT.app/...`?** That is a stale shim left over from the host's app rename: the app directory moved from `DSH NEXT.app` to `DeepSeek Harness.app`, and `~/.local/bin/dsh` still points at the removed path. Repoint the shim at the CLI entry the new host ships:
>
> ```bash
> exec "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" "$@"
> ```
>
> That entry runs `dsh/lib/bin.js` inside `app.asar` via `ELECTRON_RUN_AS_NODE`; the profile is still chosen with `--profile`.

> The npm package name carries the `@bokutake/` scope (this repository is an independent fork, moved over from upstream's `@dmh2002/`). The plugin's **configuration identity inside DSH does not** — the settings namespace, the `/plugins/dsh-connect-qoder/…` routes and the CLI program name all stay `dsh-connect-qoder`, so anyone switching from upstream or upgrading from 0.2.0 keeps their saved configuration with no need to re-enter PATs. The settings page's addressing no longer depends on the package name either: it is a `settings.section` keyed by the **unscoped** entry id. But the **browser bundle's module id**, the model-picker label and the package name the Settings button falls back to when jumping into the plugin market are still keyed by the scoped package name; these are injected from `package.json` at build time, so a rename cannot leave them behind.

### From source (development)

```bash
git clone https://github.com/bokutake/dsh-connect-qoder.git
cd dsh-connect-qoder
pnpm install
pnpm run check        # typecheck + test + build must all pass first
```

Install the repository directory with `link:` so edits take effect after a DSH restart (without reinstalling the dependency tree):

```bash
dsh plugin --profile desktop add ~/DshProject/dsh-connect-qoder
```

### Verify the installation

- Open Settings (the gear in the sidebar, or `Cmd/Ctrl + ,`) → the **Qoder** row at the bottom of the left nav → the configuration page appears with its CN / Global tabs.
- `pnpm exec dsh-connect-qoder doctor`, run inside that profile directory, should print both regions' PAT status and fingerprint derivation.
- After configuring a PAT, "Refresh from Qoder" should fetch the region's real catalog; the model picker shows `Qoder` / `Qoder Global` groups.

## Configuration

### PAT (Personal Access Token)

Create a PAT (`pt-…`) in your Qoder account settings. Two ways to provide it — **the settings page wins over the environment variable**:

| Region | Where to issue it | Setting | Environment variable |
| --- | --- | --- | --- |
| CN (qoder.com.cn) | Console → Settings → API Tokens | Card "CN" tab → Add PAT | `QODERCN_PERSONAL_ACCESS_TOKEN` |
| Global (qoder.sh) | Console → Settings → Personal Access Tokens | Card "Global" tab → Add PAT | `QODER_PERSONAL_ACCESS_TOKEN` |

- The PAT is stored only in the local plugin configuration (`regions.<region>.pat`); it is never uploaded and never enters any network request.
- A region without a PAT lists no models; the `doctor` command points out which region is missing one.
- **Step-by-step walkthrough in [`docs/PAT.md`](docs/PAT.md)** (issuing, verification, precedence, troubleshooting).

### Region enable/disable

The checkbox on each tab controls whether that region participates in the model picker (opt-out: **only an explicit uncheck disables it**). Disabling only removes the route and the directory entries; configuration is kept.

### Sidebar panel (optional, off by default)

The card's Accounts section carries a row, "Show Qoder in the sidebar": tick it and DSH's sidebar gains a Qoder icon row that opens **this same card as a full page** (the same account pool, model catalog and diagnostics, filling the centre column), with a "Back to conversation" button in its header.

- **Off by default, and an explicit opt-in.** That row claims `sidebar.panellist` — the **global sidebar seat every installed plugin shares** — and opening it takes over the centre panel, so turning it on is a decision about your whole sidebar rather than a preference about this page. Settings → Qoder already reaches the same content, so anyone who never ticked it sees **no change at all after upgrading**.
- **It takes effect on the click — no save needed.** Switching it off while the page is open returns the centre column to the conversation by itself (the host drops a `main` selection whose key no longer exists).
- Stored as the top-level `sidebarPanel` setting (**no region axis**: one row, one page, unrelated to CN / global). It therefore still opens when a region is signed out — or when both are switched off — since the panel is one of the places you go to add a first PAT.
- The test is `=== true`: absent, `false`, and a hand-edited string `"true"` all read as off.

### Multi-account pool and credential sources

Besides the settings PAT and the environment variable, each region has a local vault (`$DSH_HOME/.qoder-accounts.<region>.json`, mode 0600) that stores multiple PAT accounts. The three sources are merged de-duplicated by **settings → env → vault** (a PAT appearing in two sources is listed once, under the higher-priority source).

- The card can add (paste a `pt-…`, validated via a `JobToken` exchange that returns the display name; you may also set your own label) and rename vault accounts, and can pin a specific account to serve (`regions.<region>.accountId`, empty = automatic). Deleting a vault account is the pool table's per-row **Delete** button (which asks once before it acts); unticking and saving only takes it out of rotation.
- The selected credential is used only for the session's jobToken exchange and subsequent cosy requests — it never reaches pi-ai or the page.
- `logout [--region cn|global]` clears that region's vault accounts and pool measurements (`.qoder-accounts.<region>.json` and `.qoder-pool.<region>.json`).
- Membership, the batch actions, and the failover rules are covered in the [Account pool](#account-pool) section.

## Account pool

One machine often holds several Qoder accounts (several PATs). The **account pool** collapses that into single clicks: check accounts into the pool, then "Check in all accounts" or "Test all accounts"; switch on **Enable account pool** and the plugin automatically fails over to another account when a request fails upstream.

**Each region (CN / international) has its own pool**: members, target model, credits and check-in state never cross over — the accounts belong to different providers anyway. **Both regions have daily check-in**: the international campaign is only served to requests carrying device-risk headers, which the plugin obtains from the device-identity component shipped by the local Qoder client; if it cannot be read, the plugin reports that honestly instead of silently degrading to "no campaign today".

### Automatic failover (enabled together with the pool)

- **Ranking decides who serves**: with the pool on, **every request** goes to the top-ranked usable account, so "currently serving" may not be the account you pinned.
- **Failures walk down the list**: when a request fails upstream, the plugin retries the next usable accounts **in order**, until one takes over or all are exhausted — only then is the error surfaced.
- **What triggers a switch**: 429 rate limits, exhausted quota, rejected credentials (401/403), 5xx gateway/network failures — those are per-account states.
- **What does not**: an invalid request (HTTP 400) — the same body fails identically for everyone, so retrying only makes you wait; and a stream that has already started is never replayed (bytes are on the wire).
- **Known-bad accounts are skipped**: members inside a rate-limit cooldown or with a credential the upstream rejected do not participate. **Never-tested accounts count as usable by default** — a freshly added account should not be excluded because nobody pressed "Test" yet.
- **Your manual choice is never rewritten**: the pool overrides routing at runtime and never writes back your saved selection; turning the switch off restores your pinned account immediately.
- **Failures are remembered**: a failed request is stored as that account's measurement (including the reset time the upstream states), so the next request starts from a usable account instead of hitting the same wall again.
- **A switch is announced**: the swap is a decision the plugin made on your behalf, so it says so — the answer opens with a blockquote notice such as `> [dsh-connect-qoder] "450702134816" was rate-limited; another pool account answered instead.`. The notice names the **account that failed** (your selection), never the one that took over; consecutive swaps produce a single notice naming the failure immediately before the last hop. When nothing was swapped, nothing is written.

### What the switch actually controls

**It controls "should the plugin decide", not "are you allowed to act".**

| | Pool **on** | Pool **off** |
| --- | --- | --- |
| Who serves | chosen **automatically** by ranking (usable → expiring credits → soonest credit expiry → most credits → id) | the account **you** pick under "Which account to use" in the settings area |
| Request fails | retries the next usable account **automatically** | no switch; the error is reported as-is |
| Check in all / Test all | available | **still available** |
| Target test model | editable | **still editable** |

The last two rows are deliberate: checking in and testing are **manual actions** on the members you selected — a different question from whether the plugin routes automatically.

**The one hard rule**: with zero members checked, batch actions refuse outright. An empty pool never degrades into "then run it on all accounts" — that would be the one reading that spends credits you did not authorize.

### The retry budget is configurable (`regions.<region>.retry`)

The host has an in-place retry loop: a failure worth another attempt waits a moment and is sent again. The ladder is declared by the plugin and executed by the host; leaving it unset follows the host, so upgrading does not change your behaviour today.

```yaml
regions:
  cn:
    retry:
      maxRetries: 4        # attempts (0 = follow the host default)
      initialDelayMs: 5000 # first backoff in ms (0 = follow the host default)
      maxDelayMs: 30000    # backoff ceiling in ms (0 = follow the host default)
      queueWaitMs: 60000   # ceiling for waiting out an upstream queue (0 = off, default 60000)
```

`5000 -> 30000` covers both common upstream shapes: a transient throttle (5 s) and a `queueType:p2` queue (about 30 s). **The first three zeros mean "follow the host default"** (leaving them out equals not writing them), while `queueWaitMs: 0` turns that feature **off** — two different meanings, see below.

#### Waiting out a queue yourself (`queueWaitMs`, issue #29)

**The retry budget cannot cover "upstream explicitly asked us to wait 30 seconds".** The host's ladder is increasing (5 s -> 10 s -> 20 s -> 30 s, with jitter), so its first two attempts are **always** shorter than what upstream asked for; measured in the wild, one turn took 28 retries and 296 seconds of pure waiting, and 11 of them fired within 5 seconds of upstream saying "wait 30 seconds".

The `pi-ai` route offers no `providerRetryAfterMs` channel (re-checked in issue #24 — `retry-after` is parsed neither in that module nor in the vendor underneath), so the forwarding layer is the only place that can wait: upstream `isQueued: true` with a stated value **<= `queueWaitMs`** ⇒ wait exactly that long and resend once (that failure is not handed to the host); a stated value over the ceiling, or a resend that is still queued ⇒ passed back to the host unchanged; each request waits **once**, and the wait is interruptible.

#### Two kinds of "queued" must not be conflated (issue #29)

| Upstream field | Meaning | What the plugin does |
| --- | --- | --- |
| `isQueued:true` + `serviceAvailable:true` | the service is fine, you are in the queue | recorded as **queued**, cooled down for the stated duration; switching accounts is meaningful |
| `isQueued:true` + `serviceAvailable:false` | upstream is **refusing service overall** (measured `queueCount: 0`) | recorded as **upstream unavailable**; the switch notice says outright that this is not the account's fault |

For the first, "wait a bit" or "use another account" works; for the second, switching accounts — and switching PAT — does **not** (14 models were unavailable at once). Both shapes used to be reported as "queued", so users went off to re-provision their credentials for no reason.

### Ranking rules (who serves when the pool is on)

1. **Usable first** — accounts measured unusable (rate-limit cooldown, rejected credential) go to the back and do not participate;
2. **Accounts with credits about to lapse go first** — credits expiring within 3 days get spent before they lapse (this rule outranks your manual order below, see the notes on `rankPool`);
3. **Your manual order** (`orderAccountIds`) — a dragged order has to take effect, otherwise dragging does nothing;
4. **Soonest credit expiry → largest amount at risk → most credits** — but only with a **fresh reading** (from card polling, a batch test, or a save; valid for 10 minutes). The request path never calls upstream just to rank, otherwise one page of chat becomes N extra requests;
5. Finally account id, so the order is a total, reproducible sequence.

⚠️ **Plan expiry takes no part in ranking** (issue #31): that date answers "how long can this account keep working", which is not the same question as "will credits sitting on it lapse". Treating it as urgency would pin an account whose trial just ended to the front forever — while none of its credits will ever expire.

### The two batch actions

- **Check in all accounts** — claims the daily campaign per account. **Status is read before claiming**, so an already-claimed day is marked "checked in" without a write request (idempotent, no double claim); a failure on one account marks that row and **never aborts the batch**. Claiming changes balances, so the region's usage cache is invalidated when the batch ends.
- **Test all accounts** — one real request per member, answering "can this account use this model right now". The target model defaults to "automatic": a multiplier-0 free model in that region (largest context wins ties). You may pin one — but **testing stays disabled until a free model appears**, so credits are never spent without you knowing. Tests share the per-model probe, so they **have a real cost**.

  **The test target is independent of your enabled models** (issue #33): ticking a model decides what the DSH model picker lists, not what may be tested. Whatever the card says is the target is what a test actually probes — even if that model is not ticked under enabled models, and even when the only free model in the region is unticked. These two catalogs used to be separate (the card read the full one, the test route read a runtime one trimmed to the enabled set), and the symptom was a button that did nothing. There is exactly one catalog now.

  When the target genuinely cannot be resolved (no free model at all, or the pinned model is gone), the route answers `409` with a reason (`no-free-model` / `target-model-stale`) and the card says "no testable target model" — instead of something that reads like a broken account.

Neither batch action **locks the interface**: the button itself turns into "Checking in… / Testing…", each account's row lands as it finishes and its line is written to the activity log **individually**, stamped with that account's own completion time rather than the second the batch ended. Everything else stays usable; only **saving the config** and **deleting an account** put a veil up, since the former writes to disk and the latter is irreversible.

The settings page is laid out thus: two **independent provider cards** at the top (CN / international), each with its own border, background and right-hand switch, the selected one outlined in the brand colour — **one card is one unit**: click the name to switch tabs, click the switch to enable that provider. Below come the two credit rows ("show credits in the composer" and "position"; the whole row is clickable, the description under the title), then the optional **"Show Qoder in the sidebar"** row, then the account pool and model management. All three take effect **immediately, with no save needed**.

There is **no automatic** check-in by default: claiming collects a real reward, so it only happens when you press the button.

> Since 1.24.0 that is an **opt-in** switch (issue #36): with "Check in automatically each day" ticked, the plugin presses that button for you in the background. The reasoning is asymmetric cost — a missed window is a reward thrown away (100 credits a day for individual users, valid 30 days) and breaks the streak, while the check-in itself costs no credits and is idempotent upstream. So the honest question is not "should the plugin ever do this" but "the user may decide, once, that it should" — and the switch is that decision. It still defaults to off.

### What the plugin does when the upstream states no recovery time (issue #32)

Two states look alike and are completely different:

| | Meaning | Decided by |
| --- | --- | --- |
| `retryAtMs` present | "the upstream says this works again after that moment" | an upstream field, a reset sentence in the failure body, or **derived** from the daily check-in window |
| `retrySource: 'unknown-cooldown'` | "the upstream said nothing and the snapshot has nothing; we are retrying **every 30 minutes** on our own" | the plugin |

With `retryAtMs` absent the card used to go silent, which reads like "nothing will be retried" — while the pool was in fact hitting upstream with one real request every **30 minutes**. The fallback branch now writes `retrySource: 'unknown-cooldown'` and the card says "the upstream gave no time for when this frees up · Retrying automatically about every 30 min" — **only the source, never `retryAtMs`**: that field keeps carrying upstream or derived moments only.

The recovery point for `110` (daily usage limit) comes from the check-in row's `endAt`. That snapshot used to live only inside the process, and the fallback cooldown is exactly what applies when "the window moment is unknown", so **every restart made the fallback apply**. The window moment is now written to the `windows` key of `$DSH_HOME/.qoder-pool.<region>.json` and read back after a restart (in-process first, then disk; **a moment already in the past is not used**).

### Automatic check-in counts WINDOWS, not calendar days (issue #36)

Qoder's daily window is a **fixed absolute moment**: 10:00 today → 09:59 tomorrow (UTC+8). "Checked in today?" has to be decided per **window** — copying the local calendar day would treat 00:05 as a new day (an idempotent `already`, recorded as done) while at 10:00, when the window really opens, the state still says "finished", so the new window's reward waits until 00:05 the next day, fourteen hours late. A window's identity is "(now − 2 hours) in UTC", and the moment upstream states (`endAt`) is preferred. Progress lives in its own file, `$DSH_HOME/.qoder-auto-checkin.<region>.json` (`0600`), not in settings — otherwise one Save would overwrite the runner state with a draft from minutes ago.

## CLI diagnostics

Run **inside the profile directory that has the plugin installed** (recommended, no global install):

```bash
cd ~/.dsh/profiles/desktop
pnpm exec dsh-connect-qoder doctor    # PAT source + cosy fingerprint + pi-ai generation + heartbeat + vault counts (offline)
pnpm exec dsh-connect-qoder status    # per region: credential source + upstream model-list reachability + remaining credits (needs PAT)
pnpm exec dsh-connect-qoder logout --region cn   # clear that region's vault accounts and pool measurements
pnpm exec dsh-connect-qoder doctor --json        # machine-readable output
```

`status` really exchanges a jobToken and fetches the model catalog (then reads usage once, read-only), so it needs that region's environment or vault PAT; `doctor` is fully offline.

> **Two things measured on a real machine**:
> 1. **Do not use a bare path like `node node_modules/dsh-connect-qoder/lib/bin.js`** — the package name is scoped, so the symlink lives at `node_modules/@bokutake/dsh-connect-qoder` (it was `@dmh2002/` before the fork); the old path just gives `MODULE_NOT_FOUND` (a missing **entry file**, not a missing peer).
> 2. The CLI depends on the host-provided peers (`@deepseek-ai/dsh-atomic-write` / `dsh-home-paths`). Locally, pnpm installs them into the profile's dependency tree, and both `pnpm exec` and an npm-installed tarball work. But that **depends on your pnpm version and `auto-install-peers` setting** — if you see `Cannot find package '@deepseek-ai/dsh-atomic-write'`, that layer did not get installed. Provider registration, the settings page and chat are **unaffected** (they run inside the host, which resolves those names). The sibling workbuddy's issue #47 is the same shape; its fix (host-first, fall back to a built-in copy on demand) applies here too and has not been ported yet.

## Platform support

| Platform | Status |
| --- | --- |
| macOS | ✅ Verified (development and CI) |
| Windows | ✅ CI tests pass (upstream uses standard fetch; no platform-specific paths) |
| Linux | ✅ CI tests pass |

## Supported host line

| Host | Peer range |
| --- | --- |
| DSH (`@deepseek-ai/*`) | `>=0.1.7-rc.1 <0.2.0-0 \|\| >=0.2.0-rc.1 <0.3.0-0 \|\| >=0.2.1-rc.1 <0.3.0-0 \|\| >=0.2.2-rc.1 <0.3.0-0` |
| `@earendil-works/pi-ai` | `>=0.85.0 <0.88.0 \|\| >=1.0.0 <2.0.0` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

> Enforced by `tests/dsh-line.spec.ts`. DSH only ships prereleases, and node-semver admits a prerelease **only** when some comparator in the range names that exact `major.minor.patch` tuple *and* carries a prerelease tag — so every new line needs its own branch. Writing `>=0.1.7-rc.1 <0.3.0-0` silently excludes the whole `0.2.0-rc.*` line; likewise `>=0.2.0-rc.1` does **not** cover `0.2.1-rc.1` (which Desktop 0.2.1-rc.1 ships). The upper bound must keep `-0` (`<0.3.0` blocks nothing).
>
> **Two semver readings coexist** (corrected by measurement in 1.1.2): **npm / pnpm installation** uses node-semver's **standard** reading, so a new patch line's rc (`0.2.2-rc.1` got its branch on 2026-11-05; `0.2.3-rc.1` is next) really does still need a hand-added branch — that is what `UNGATED_PRERELEASES` tracks. But the **host's plugin-compatibility gate does not use the standard reading**: `dsh-app-boot` calls `semver.satisfies(v, range, { includePrerelease: true })`, under which `>=0.2.1-rc.1 <0.3.0-0` alone covers the **whole `0.2.x` line** (`0.2.2-rc.1`, `0.2.9` all pass) while `0.3.0-rc.1` is still blocked by the ceiling. 1.1.0/1.1.1 claimed "no static range can cover any `0.2.x` prerelease" — true for npm, false for the host gate, now corrected.
>
> **pi-ai gets its own row** because it changed major: Desktop 0.2.1-rc.1 moved pi-ai from 0.85 to 1.x, and the two generations consume different context shapes (1.x normalizes in its Models layer). The declaration and the runtime detection must agree — otherwise you get the silent tool-loss bug fixed in 1.1.0. See [`docs/DSH-0.2.1-RC1-FOLLOWUP.md`](docs/DSH-0.2.1-RC1-FOLLOWUP.md).

**Current baseline: host `0.2.2-rc.5` (measured 2026-11-19)**, with pi-ai `1.3.0`, cordis `4.1.0`, schemastery `3.19.0`. The rc.5 round **changed no runtime code**, and the peer range needed no new branch.

Per-round, per-package audits are archived under `docs/`:

- [`docs/DSH-0.2.2-RC5-FOLLOWUP.md`](docs/DSH-0.2.2-RC5-FOLLOWUP.md) — current baseline (across rc.4 / rc.5)
- [`docs/DSH-0.2.2-RC3-FOLLOWUP.md`](docs/DSH-0.2.2-RC3-FOLLOWUP.md) — no runtime changes; the slot catalog went from 114 to 116 entries
- [`docs/DSH-0.2.2-RC2-FOLLOWUP.md`](docs/DSH-0.2.2-RC2-FOLLOWUP.md) — no runtime changes; the failure-classifier fixture had to be re-extracted
- [`docs/DSH-0.2.2-RC1-FOLLOWUP.md`](docs/DSH-0.2.2-RC1-FOLLOWUP.md) — the round that **needed adaptation**: new required fields on `ResolvedPiAiProviderProfile`, pi-ai 1.3.0's branded `TranscriptContext`, a widened `ctx.locale.register` signature
- [`docs/DSH-0.2.1-RC1-FOLLOWUP.md`](docs/DSH-0.2.1-RC1-FOLLOWUP.md) — the pi-ai 0.85 → 1.x move, and why pi-ai gets a row of its own

## Known limitations

- This depends on Qoder's cosy gateway and `sash` endpoints (**not an official public API**); upstream changes may require plugin changes. The protocol behavior is referenced from [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api) and independently implemented here — no source is copied.
- **Daily check-in** is Qoder's operational campaign for **individual** accounts (organization accounts do not participate); the rules and amounts are the vendor's to change. The international campaign requires the device identity that the local Qoder client provides, so **on a machine without the Qoder desktop client, international check-in is unavailable** (the plugin says so explicitly rather than degrading silently).
- Image input and "off-able thinking" are offered per a **verified** list: models outside it are never pre-checked, so one that actually works may need a manual check from you. **The image switch is a whitelist** — once you have saved a selection, un-checked models stay off; un-checking everything and saving keeps them off instead of letting the defaults switch them back on.
- Per-model and batch tests **send real requests** and consume a little upstream credit. There is no "test all checked" button, and batch actions only touch accounts you explicitly checked into the pool.
- **The standalone CLI depends on host-provided peers** (`@deepseek-ai/dsh-atomic-write` / `dsh-home-paths`). Locally pnpm installs them alongside the package and `pnpm exec dsh-connect-qoder …` works; if your pnpm configuration does not, the CLI reports `Cannot find package …`. Provider registration, the settings page and chat are unaffected — they run inside the host, which resolves those names. The workbuddy fix (host-first, fall back to a built-in copy) applies here and has not been ported yet.
- **`403 + 10605 / RESOURCE_LIMIT` can also be a content refusal, not rate limiting.** Qoder CN refuses by **request content**, and the envelope it returns is byte-for-byte identical to "the upstream is not serving", so the plugin cannot tell the two apart. One confirmed trigger is the whole `harness:identity` sentence in DSH's default system prompt. Diagnosis and the workaround (`includeHarnessIdentity: false` + `personaPrefix`) are in [`docs/TROUBLESHOOTING.en.md`](docs/TROUBLESHOOTING.en.md).

## Security notes

- The PAT is stored only in the local plugin configuration (or an environment variable) and **never enters any network request**; external calls always use cosy session tokens (jobToken) plus machine-fingerprint headers.
- The local shim is a random-port loopback service with an in-process secret, verifying Host / Origin / Content-Type, with a 64 MB request-body cap.
- The plugin only reads PATs you explicitly provide; it **never reads or modifies** Qoder desktop sign-in/credential files.
- Diagnostic output (`doctor` / `status` and card probes) is redacted and never prints token-like strings.

## Privacy & screenshots

**No real account data ever appears in the repository or the npm tarball.** This is a hard rule; the details live in [docs/PRIVACY.md](docs/PRIVACY.md):

- Every screenshot in the README and `docs/` is **captured with fake data**: the account name is `acct-demo`, addresses are `account-a@example.com`, balances are round numbers. **Redaction means an opaque block or a replaced value — blur, mosaic and translucent overlays do not count**, because they preserve character widths and the light/dark distribution.
- Code comments and CHANGELOG entries that record "what the user saw" keep the observation and drop the identity.
- `tests/privacy.spec.ts` scans the repo for real email addresses, upstream nicknames, credential fingerprints, absolute local paths and credential bodies, and CI runs it as its own step. **It cannot read image content**, so a new or replaced image under `docs/assets/` still has to be opened and looked at by a human.

> This rule was written after a lesson: earlier releases used real data in the screenshots, which has since been replaced with fake values. "What to do after a leak" is in [docs/PRIVACY.md](docs/PRIVACY.md).

## Disclaimer

- This project is **for personal learning and research only**; it drives only your own Qoder account on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the Qoder / Lingma terms of service; any consequence of using this project (including account restrictions, quota wipe or service interruption) is borne by the user.
- The author accepts no liability for any direct or indirect loss caused by using or misusing this project.
- This project is unaffiliated with Alibaba, Lingma, Qoder, or DeepSeek and is not endorsed or authorized by them; names appear only to describe compatibility, and their trademarks belong to their respective owners.

## Market listing and presentation

The plugin declares a `dsh.bundle` manifest (`dsh.bundle.patch: ./cordis.patch.yml`), so `dsh plugin add` works. Community markets sync entries from the [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry; the submission draft lives in [`awesome-dsh-plugin-submission/dingminhua__dsh-connect-qoder.yml`](awesome-dsh-plugin-submission/dingminhua__dsh-connect-qoder.yml), and the submission rules are in that repository's [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md).

Market screenshots and GitHub badges are two different mechanisms: **market screenshots** are declared by [`screenshots.json`](screenshots.json) in this repository's root; **badges** come from the Shields links at the top of this README; **market icons** follow each storefront's own display rules — neither an npm field nor a README badge.

## Acknowledgements

This project builds on other people's public work — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md):

- [**Zhengyuuuui/qoder2api**](https://github.com/Zhengyuuuui/qoder2api): reference implementation of the cosy protocol wire behavior (encoding, signing, sessions, fingerprints, jobToken, SSE shapes, error classification). This project **independently re-implements** that behavior in TypeScript and copies no source code; the repository ships no standalone LICENSE and its README points at `wangtufly/QCCG` (GPL-3.0).
- [**L0NE-6/Qoder-Daily**](https://github.com/L0NE-6/Qoder-Daily) (MIT): reference for the daily check-in protocol (the `campaigns` / `claim` shapes, idempotency, and the international device-risk idea). This project independently implements it from that documentation plus local measurement, copying no source.
- [**dingminhua/dsh-connect-workbuddy**](https://github.com/dingminhua/dsh-connect-workbuddy) (MIT): baseline for the plugin engineering layout, card interaction model, loopback shim pattern, and npm publishing workflow.
- [**dingminhua/dsh-connect-trae**](https://github.com/dingminhua/dsh-connect-trae) (MIT): card look & publishing baseline, referenced via workbuddy.
- [**franksong2702/dsh-codex-connect**](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0): DSH plugin structure and pi-ai provider registration, referenced via workbuddy.
- Qoder official SDK type definitions: used only to cross-check usage/header shapes; not distributed.

## License

MIT © LaoDing — see [LICENSE](LICENSE).