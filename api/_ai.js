// matbyus — the one door to the model. FSD Phase 3, TSD Phase 3.
//
// Every AI feature goes through runFeature(): it loads the feature's settings from mb_ai_features
// (on/off, model, effort, limits, instructions — all rows, none of it here), checks who is asking
// and whether they are within their daily limit, calls Claude through the official SDK with a JSON
// schema the answer must fit, and records the call in mb_ai_usage as counts and tokens only. Each
// feature's handler in api/ai/index.js supplies the schema, the reference data and the user's text,
// and validates what comes back against the database before anyone sees it.
//
// Three properties the rest of the app relies on:
//   * The model's answer is never trusted as-is. It is parsed against a schema here, then checked
//     against the lookup tables by the caller — an enum in a schema narrows a guess, it does not
//     prove the row still exists.
//   * Nothing about the request or the answer is written anywhere (NFR-31). mb_ai_usage holds which
//     feature, whose limit, which model actually answered, the token counts, and the outcome.
//   * The app works with AI off (NFR-33). No key, a switched-off feature, a reached limit, a refusal
//     and an outage each become a status code and a plain sentence, and nothing else is affected.

import Anthropic from '@anthropic-ai/sdk';
import { fail, configError, sha256, clientIp } from './_lib.js';
import { lookups } from './_lookups.js';

// The function itself may run 60s (vercel.json). One attempt plus one retry must fit inside that
// with room to write the usage row and answer — so 25s per attempt.
const TIMEOUT_MS = 25_000;
const MAX_RETRIES = 1;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client = null;
let injected = null;

// Tests hand in a fake with the same `beta.messages.create` shape (NFR-35). Nothing else calls this.
export function setAiClientForTests(fake) { injected = fake; client = null; }

export const aiConfigured = () =>
  !!injected || !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN;

function aiClient() {
  if (injected) return injected;
  if (!aiConfigured()) throw configError('ANTHROPIC_API_KEY is not set, so AI features are off');
  // The zero-argument constructor resolves the credential from the environment; the key never
  // passes through this file.
  if (!client) client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  return client;
}

// --- settings ------------------------------------------------------------------

// Read live rather than through the lookup cache: an admin who switches a feature off expects its
// button gone and its endpoint closed on the next request, not within the minute.
export async function loadFeature(db, feature) {
  const [row] = await db.query('SELECT * FROM mb_ai_features WHERE feature = $1', [feature]);
  return row || null;
}

export async function loadFeatures(db) {
  return db.query('SELECT * FROM mb_ai_features ORDER BY sort_order, feature');
}

// Whether this caller may use this feature at all — the same rows the front end reads to decide
// which buttons to draw, so a button is never offered for a call that would be refused.
export function mayUse(row, account) {
  if (!row || !row.enabled) return false;
  if (!account) return !!row.allow_visitors;
  return (row.allowed_roles || []).includes(account.role);
}

// Whose daily limit a call counts against. A visitor is keyed by a hash of their address, so the
// usage table is not a log of who browsed from where.
export const actorKeyFor = (req, account) =>
  account ? 'u:' + account.id : 'v:' + sha256('matbyus-ai:' + clientIp(req));

async function withinLimits(db, row, actorKey) {
  if (row.daily_limit_per_user) {
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM mb_ai_usage
        WHERE feature = $1 AND actor_key = $2 AND created_at > now() - interval '24 hours'`,
      [row.feature, actorKey]);
    if (n >= row.daily_limit_per_user) {
      throw fail(429, `You have used ${row.label.toLowerCase()} ${n} times today, which is the daily limit. Please try again tomorrow.`);
    }
  }
  if (row.daily_limit_total) {
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM mb_ai_usage
        WHERE feature = $1 AND created_at > now() - interval '24 hours'`, [row.feature]);
    if (n >= row.daily_limit_total) {
      throw fail(429, `${row.label} has reached today's limit across matbyus. Please try again tomorrow.`);
    }
  }
}

async function record(db, entry) {
  try {
    await db.query(
      `INSERT INTO mb_ai_usage (feature, user_id, actor_key, model, status, input_tokens, output_tokens,
                                cache_read_tokens, cache_write_tokens, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.feature, entry.userId || null, entry.actorKey, entry.model || null, entry.status,
       entry.usage?.input_tokens || 0, entry.usage?.output_tokens || 0,
       entry.usage?.cache_read_input_tokens || 0, entry.usage?.cache_creation_input_tokens || 0,
       entry.latencyMs ?? null]);
  } catch (e) {
    // A failed usage row must not turn a good answer into an error. Code and message only (NFR-24).
    console.error('matbyus ai usage record failed:', e?.code || '', e?.message || '');
  }
}

// --- the call -------------------------------------------------------------------

// Runs one feature end to end. `reference` is extra system text built from the database (the
// catalogue, the category list) — stable between requests, so it is cached with the instructions.
// `input` is the person's text or the gathered data, already wrapped in the tags the feature's
// instructions name. Returns the parsed answer; throws a status error otherwise.
export async function runFeature(db, req, account, featureKey, { schema, reference = '', input }) {
  const row = await loadFeature(db, featureKey);
  if (!row) throw fail(404, 'That AI feature does not exist.');
  if (!row.enabled) throw fail(503, `${row.label} is switched off at the moment.`);
  if (!account && !row.allow_visitors) throw fail(401, 'Please sign in to use this.');
  if (!mayUse(row, account)) throw fail(403, 'You do not have access to this.');

  const actorKey = actorKeyFor(req, account);
  await withinLimits(db, row, actorKey);

  const lk = await lookups(db);
  const sdk = aiClient();

  // The instructions first, then the reference data, with the cache breakpoint on the last stable
  // block: everything above the person's own text is identical between requests until an admin
  // edits the prompt or the catalogue changes (shared prompt-caching guidance: stable first).
  const system = [{ type: 'text', text: row.system_prompt }];
  if (reference) system.push({ type: 'text', text: reference });
  system[system.length - 1].cache_control = { type: 'ephemeral' };

  const params = {
    model: row.model,
    max_tokens: row.max_tokens,
    system,
    // Thinking is left to the model's adaptive default; effort is the dial (low for extraction and
    // translation, medium for planning and advice — set per feature in mb_ai_features).
    output_config: { effort: row.effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: input }],
  };
  // C13: on a model that supports it, a safety decline is retried on a fallback model inside the
  // same call. Which models support it is mb_lookups ai_model meta, not a list here.
  if (lk.meta('ai_model', row.model)?.fallbacks) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }

  const started = Date.now();
  const base = { feature: row.feature, userId: account?.id, actorKey };
  let res;
  try {
    res = await sdk.beta.messages.create(params);
  } catch (e) {
    await record(db, { ...base, model: row.model, status: 'error', latencyMs: Date.now() - started });
    // Most specific first (shared/error-codes.md). The message never echoes the request.
    if (e instanceof Anthropic.AuthenticationError) throw configError('the AI key was rejected');
    if (e instanceof Anthropic.RateLimitError) throw fail(503, 'The assistant is busy. Please try again in a minute.');
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw fail(504, 'The assistant took too long to answer. Please try again.');
    if (e instanceof Anthropic.APIError) throw fail(502, 'The assistant is unavailable right now. Everything else still works.');
    throw e;
  }

  const latencyMs = Date.now() - started;
  const served = { ...base, model: res.model || row.model, usage: res.usage, latencyMs };

  // stop_reason before content, always: a refusal or a truncated answer may not fit the schema.
  if (res.stop_reason === 'refusal') {
    await record(db, { ...served, status: 'refused' });
    throw fail(422, 'The assistant could not help with that request. Try wording it differently.');
  }
  if (res.stop_reason === 'max_tokens') {
    await record(db, { ...served, status: 'invalid' });
    throw fail(502, 'The assistant\'s answer was cut short. Try a shorter request.');
  }

  const text = (res.content || []).find(b => b.type === 'text')?.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    await record(db, { ...served, status: 'invalid' });
    throw fail(502, 'The assistant gave an answer that could not be read. Please try again.');
  }
  await record(db, { ...served, status: 'ok' });
  return { answer: parsed, model: served.model, row };
}

// The usage report AI settings shows. Counts and tokens only — there is nothing else to show.
export async function usageSummary(db, days = 7) {
  return db.query(
    `SELECT feature, model,
            count(*)::int AS calls,
            count(*) FILTER (WHERE status = 'ok')::int AS ok,
            count(*) FILTER (WHERE status = 'refused')::int AS refused,
            count(*) FILTER (WHERE status IN ('invalid','error'))::int AS failed,
            COALESCE(sum(input_tokens), 0)::int AS input_tokens,
            COALESCE(sum(output_tokens), 0)::int AS output_tokens,
            COALESCE(sum(cache_read_tokens), 0)::int AS cache_read_tokens,
            COALESCE(sum(cache_write_tokens), 0)::int AS cache_write_tokens
       FROM mb_ai_usage
      WHERE created_at > now() - make_interval(days => $1)
      GROUP BY feature, model ORDER BY feature, model`, [days]);
}
