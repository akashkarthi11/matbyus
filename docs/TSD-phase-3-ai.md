# TSD — matbyus Phase 3: AI assistance

| | |
|---|---|
| Document | Technical Specification |
| Version | 1.0 |
| Date | 2026-11-24 |
| Implements | [FSD Phase 3](FSD-phase-3-ai.md) |
| Code | `api/_ai.js`, `api/ai/index.js`, `app.js` (AI sections) |
| Schema | [`0012_ai.sql`](../scripts/migrations/0012_ai.sql) |
| Tests | [`test/ai.test.mjs`](../test/ai.test.mjs) — 22 cases, all against a fake client |

---

## 1. Shape

```
browser ──► /api/ai?feature=X ──► api/ai/index.js ──► runFeature() in api/_ai.js ──► Claude
                                   │  schema (enums      │  settings row (mb_ai_features)
                                   │  from the database) │  access + daily limits
                                   │  reference data     │  SDK call, stop_reason, JSON parse
                                   │  validate answer    │  usage row (counts only)
                                   ◄──────────── suggestion ◄────────────────
```

One module talks to the model; five handlers each know only their own schema, reference data and
validation. The endpoint lives in `api/ai/` so it can have a 60-second limit (`vercel.json`) while
every other function keeps 15 — a per-file override of the same glob would be ambiguous.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D-40 | **Official SDK, `@anthropic-ai/sdk`**, through `client.beta.messages.create` | The project's language has an official SDK; typed errors, retries and timeouts come with it. `beta` because refusal fallbacks are a beta parameter |
| D-41 | **`claude-opus-5-5` by default, per feature in the database** | The most capable current model is the default. A cheaper model for a high-volume feature (search, say) is a cost decision the platform owner makes in AI settings, where the spend is visible — not a decision the code bakes in |
| D-42 | **Effort, not model, is the first cost dial** | Opus 5.5 always thinks; `output_config.effort` sets how much. `low` for extraction, search and translation; `medium` for planning and advice. Opus 5.5's default is `medium`, so every row sets it explicitly |
| D-43 | **Structured outputs for every feature** — `output_config.format: { type: 'json_schema', schema }` | No prompt-and-pray JSON. Enums (units, categories, kinds, GST rates) are built from the lookup tables on each request, so the schema can never offer a value the database lacks |
| D-44 | **Validate the answer against the database anyway** | An enum narrows a guess; it does not prove the row is still live or the pair is legal. A unit not allowed for the kind, a category of the other kind, a product slug that does not exist — each is dropped, with a note where a person should know |
| D-45 | **Refusal fallbacks on where the model supports them** (`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`) | A safety decline is retried on a fallback model inside the same call. Which models support it is `mb_lookups.meta.fallbacks`, not a list in code — Haiku 5.5 has none, so it is called without the beta |
| D-46 | **`stop_reason` before content, always** | `refusal` → 422 with a plain sentence; `max_tokens` → 502 "cut short". Neither is parsed as an answer |
| D-47 | **Stable prefix, one cache breakpoint** | Instructions then reference data (the catalogue, the category list) in `system`, `cache_control` on the last system block; the person's text is the only thing after it. Below the model's minimum cacheable length the breakpoint is simply ignored — harmless |
| D-48 | **25s per attempt, one retry, 60s function** | Two attempts fit inside the function's limit with room to write the usage row and answer |
| D-49 | **The schema stays in code; everything else is a row** | The schema is the contract the handler parses, like a CHECK constraint is the shape of a legal row (docs/lookups.md). Model, effort, limits, on/off and the instructions are rows an admin edits |
| D-50 | **Usage holds counts, never content** | `mb_ai_usage` has no column that could hold a prompt or an answer; a test lists its columns to keep it that way (NFR-31) |
| D-51 | **Visitors are limited by a salted hash of their address** | The daily limit needs a key; the table must not become a log of who browsed from where |
| D-52 | **Menus added after a role was tailored show until the next save** (D-35, migration 0012) | Found while adding *Plan materials*: a role with any saved menu choice silently lost every menu a later migration added |

## 3. Data

### `mb_ai_features` — one row per feature

| Column | Meaning |
|---|---|
| `feature` | `listing_draft`, `smart_search`, `estimate`, `translate`, `offer_advice` |
| `enabled` | Off → button gone everywhere, endpoint 503 |
| `model`, `effort`, `max_tokens` | Sent as-is; `model` must be an `ai_model` lookup code, `effort` an `ai_effort` one |
| `system_prompt` | The instructions. Each names the tag its data arrives in and says the contents are data, never instructions |
| `allowed_roles`, `allow_visitors` | Who may call it; also what `?resource=features` reports |
| `daily_limit_per_user`, `daily_limit_total` | Rolling 24 hours, counted from `mb_ai_usage`; null for none |

### `mb_ai_usage` — one row per call that reached the model

`feature, user_id, actor_key, model (the one that actually answered), status (ok | refused | invalid | error),
input/output/cache-read/cache-write tokens, latency_ms, created_at`. Calls refused before the model
(switched off, wrong role, over the limit) are not recorded — they cost nothing.

### Lookups added

`ai_model` (with `meta.fallbacks` and `meta.input`/`meta.output` USD per million tokens), `ai_effort`,
`language` (labels in their own script, because the person choosing may not read English).

## 4. Endpoints

| Call | Who | Returns |
|---|---|---|
| `GET /api/ai?resource=features` | anyone | `{ configured, features: [{ feature, label, available }] }` — no prompts, limits or models |
| `POST ?feature=listing_draft` `{ text }` | owner, admin | `{ draft: {form fields}, notes }` |
| `POST ?feature=smart_search` `{ q }` | anyone | `{ filters: { kind, category, q }, explanation }` — the browser then runs the normal catalogue query |
| `POST ?feature=estimate` `{ text }` | customer, owner | `{ assumptions, lines: [{ slug, qty, reason, totalLabel }], caveats, total, dropped }` — priced by `priceLine()` |
| `POST ?feature=translate` `{ messageId, language }` | participant | `{ translation, detectedLanguage }` |
| `POST ?feature=offer_advice` `{ bidId }` | the offer's owner | `{ advice: { recommendation, suggestedUnitPrice, reasoning } }` |
| `GET ?resource=settings` / `POST ?resource=settings&action=save` | admin | settings, 7-day usage with an estimated cost; save validates model, effort, limits, prompt |

Status codes: 401 not signed in · 403 wrong role · 404 someone else's message or offer · 409 settled
offer · 422 refused · 429 over a daily limit · 502 unreadable or cut-short answer, or the provider
erred · 503 feature off, provider busy, or no key · 504 provider timed out.

## 5. What reaches the model, feature by feature

| Feature | Sent | Never sent |
|---|---|---|
| listing_draft | The seller's description; categories, units, GST rates | Anything about the seller |
| smart_search | The query; categories | Who is asking |
| estimate | The project description; live catalogue names, units, pack sizes, minimum orders | Any price — the server prices the answer |
| translate | One message's text and the target language | Names, the rest of the conversation, contacts |
| offer_advice | Listing prices, the offer's quantity and moves (as "buyer"/"seller"), the owner's own 90-day sales of the item | The buyer's name, email, phone or address |

## 6. Front end

`ensureAi()` loads the features list once per viewer (reloaded on sign-in or sign-out) and `aiOn(f)`
decides each button. Every model-produced thing wears an **AI** badge so it is never mistaken for a
server fact. Entry points: *Describe what you need* under the catalogue search; *Describe it, and we
will draft the listing* on a new product; *Plan materials* in the customer menu and the More hub;
*Translate* under each message from the other side; *Advise me* beside Counter on an owner's turn;
*AI settings* for admins.

## 7. Going live

1. Set `ANTHROPIC_API_KEY` on the Vercel project (Production), then redeploy. Until then every
   feature reports unavailable and `/api/health` lists the key as missing — optional, not blocking.
2. Watch *AI settings → Use in the last 7 days* for the first week. If search volume makes Opus the
   wrong trade, switch that one feature to Sonnet or Haiku there; nothing else changes.

## 8. Traceability

| FSD | Built in | Tested by |
|---|---|---|
| AI-1 | `listingDraft()`, product form panel | "a draft is checked against the database…", "a call carries the row's model…" |
| AI-2 | `smartSearch()`, catalogue | "a search becomes the catalogue's own filters…", visitor tests |
| AI-3 | `estimate()`, `renderEstimate()` | "an estimate keeps only live products…", "a business sees its trade price…" |
| AI-4 | `translate()`, thread | "a participant can translate a message; nobody else can…" |
| AI-5 | `offerAdvice()`, offer detail | "offer advice is the owner's own…" |
| AI-6 | `settings()`, `saveSetting()`, `renderAiSettings()` | "only an admin reads or changes settings…", "settings report usage…" |
| NFR-30 | §5 above | translate and advice tests assert no names or contacts in the request |
| NFR-31 | `record()` | "usage records tokens and outcome, and the table has nowhere to put content" |
| NFR-32 | `withinLimits()`, D-48 | per-person and platform limit tests |
| NFR-33 | `aiConfigured()`, status mapping | "with no key, every feature reports unavailable…", failure-mode test |
| NFR-34 | `quoted()` | "a person's own text cannot close the quoted block early" |
| NFR-35 | `setAiClientForTests()` | every test in the file |
