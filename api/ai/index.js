// matbyus — AI assistance. FSD Phase 3 AI-1 to AI-6.
//
//   GET  /api/ai?resource=features                 -> { configured, features: [{ feature, label, available }] }
//   POST /api/ai?feature=listing_draft             { text }              -> { draft, notes }
//   POST /api/ai?feature=smart_search              { q }                 -> { filters, explanation }
//   POST /api/ai?feature=estimate                  { text }              -> { assumptions, lines, caveats, total }
//   POST /api/ai?feature=translate                 { messageId, language } -> { translation, detectedLanguage }
//   POST /api/ai?feature=offer_advice              { bidId }             -> { advice }
//   GET  /api/ai?resource=settings                 admin -> { features, usage, models, efforts }
//   POST /api/ai?resource=settings&action=save     admin -> { feature }
//
// Every feature goes through runFeature() in api/_ai.js. What each handler here adds is the part
// only it knows: the schema its answer must fit (enums filled from the database), the reference
// data the model needs, and the check of the answer against the database afterwards. The model
// suggests; nothing here writes a listing, an order, a bid, a basket line or a message (C14).

import { json, body, fail, sessionAccount } from '../_lib.js';
import { db as defaultDb } from '../_db.js';
import { isAdmin, isApprovedBusiness, requireAdmin } from '../_roles.js';
import { lookups } from '../_lookups.js';
import { toPaise, fromPaise, formatInr } from '../_india.js';
import { priceLine } from '../orders.js';
import { runFeature, loadFeatures, mayUse, aiConfigured, usageSummary } from '../_ai.js';

const str = v => String(v ?? '').trim();
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const strings = { type: 'array', items: { type: 'string' } };

// A quoted block for the model. The tags are named in each feature's instructions as data, never
// instructions (NFR-34); a closing tag inside the person's text is neutralised so it cannot end
// the block early.
const quoted = (tag, text) =>
  `<${tag}>\n${String(text).replaceAll(`</${tag}>`, `</ ${tag}>`)}\n</${tag}>`;

function readText(raw, max, what) {
  const text = str(raw);
  if (!text) throw fail(400, `Describe the ${what} first.`);
  if (text.length > max) throw fail(400, `That is too long — keep it under ${max} characters.`);
  return text;
}

const slugify = s => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const money = n => (Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null);

const TAX_NOTE = 'Confirm the GST rate and HSN/SAC code with your tax adviser before putting this live.';

async function activeCategories(db) {
  return db.query('SELECT id, slug, name, kind FROM mb_categories WHERE is_active ORDER BY kind, sort_order, name');
}

// --- AI-1: draft a listing -------------------------------------------------------

async function listingDraft(db, req, account, d) {
  const text = readText(d.text, 2000, 'product');
  const lk = await lookups(db);
  const categories = await activeCategories(db);
  const kinds = (lk.lookup.product_kind || []).map(x => x.code);
  const modes = (lk.lookup.pricing_mode || []).map(x => x.code);
  const rates = (lk.lookup.gst_rate || []).map(x => x.code);

  const schema = {
    type: 'object', additionalProperties: false,
    required: ['name', 'kind', 'category_slug', 'unit', 'pack_size', 'summary', 'description',
      'pricing_mode', 'price_retail', 'hsn_sac', 'gst_rate', 'notes'],
    properties: {
      name: { type: 'string' },
      kind: { type: 'string', enum: kinds },
      category_slug: nullable({ type: 'string', enum: categories.map(c => c.slug) }),
      unit: nullable({ type: 'string', enum: lk.unitCodes }),
      pack_size: nullable({ type: 'number' }),
      summary: nullable({ type: 'string' }),
      description: nullable({ type: 'string' }),
      pricing_mode: { type: 'string', enum: modes },
      price_retail: nullable({ type: 'number' }),
      hsn_sac: nullable({ type: 'string' }),
      gst_rate: nullable({ type: 'string', enum: rates }),
      notes: strings,
    },
  };

  const reference = [
    'Categories (slug — name — kind):',
    ...categories.map(c => `- ${c.slug} — ${c.name} — ${c.kind}`),
    '', 'Units (code — label — usable for):',
    ...lk.units.map(u => `- ${u.code} — ${u.label} — ${u.applies_to === 'both' ? 'material or service' : u.applies_to}`),
    '', 'GST rates offered: ' + (lk.lookup.gst_rate || []).map(r => r.label).join(', '),
  ].join('\n');

  const { answer: a } = await runFeature(db, req, account, 'listing_draft', {
    schema, reference, input: quoted('seller_description', text),
  });

  // The schema narrowed the guess; the database decides. Anything that fails a rule the product
  // form would also enforce is dropped here with a note, so the draft never prefills a value the
  // save would refuse.
  const notes = Array.isArray(a.notes) ? a.notes.map(str).filter(Boolean) : [];
  const kind = kinds.includes(a.kind) ? a.kind : kinds[0];
  let category = categories.find(c => c.slug === a.category_slug) || null;
  if (category && category.kind !== kind) {
    notes.push(`The suggested category "${category.name}" is for ${category.kind}s, so it was left empty.`);
    category = null;
  }
  let unit = lk.unit(a.unit) ? a.unit : null;
  if (unit && !lk.unitAllowedFor(unit, kind)) {
    notes.push(`A ${kind} cannot be sold per ${lk.unit(unit).label}, so the unit was left empty.`);
    unit = null;
  }
  const mode = modes.includes(a.pricing_mode) ? a.pricing_mode : 'fixed';
  const hsn = /^[0-9]{4,8}$/.test(str(a.hsn_sac)) ? str(a.hsn_sac) : null;
  if (a.hsn_sac && !hsn) notes.push('The suggested HSN/SAC code did not look like one, so it was left empty.');
  if (!notes.some(n => /tax adviser/i.test(n))) notes.push(TAX_NOTE);

  const name = str(a.name).slice(0, 120);
  return {
    draft: {
      name,
      slug: slugify(name),
      kind,
      category_id: category?.id || null,
      unit,
      pack_size: kind === 'material' ? money(a.pack_size) : null,
      summary: a.summary ? str(a.summary).slice(0, 200) : null,
      description: a.description ? str(a.description).slice(0, 2000) : null,
      pricing_mode: mode,
      price_retail: mode === 'fixed' && money(a.price_retail) != null ? money(a.price_retail).toFixed(2) : null,
      hsn_sac: hsn,
      gst_rate: rates.includes(a.gst_rate) ? a.gst_rate : null,
    },
    notes,
  };
}

// --- AI-2: search in plain words ----------------------------------------------------

async function smartSearch(db, req, account, d) {
  const q = readText(d.q, 200, 'search');
  const lk = await lookups(db);
  const categories = await activeCategories(db);
  const kinds = (lk.lookup.product_kind || []).map(x => x.code);

  const schema = {
    type: 'object', additionalProperties: false,
    required: ['kind', 'category_slug', 'keywords', 'explanation'],
    properties: {
      kind: nullable({ type: 'string', enum: kinds }),
      category_slug: nullable({ type: 'string', enum: categories.map(c => c.slug) }),
      keywords: { type: 'string' },
      explanation: { type: 'string' },
    },
  };
  const reference = ['Categories (slug — name — kind):',
    ...categories.map(c => `- ${c.slug} — ${c.name} — ${c.kind}`)].join('\n');

  const { answer: a } = await runFeature(db, req, account, 'smart_search', {
    schema, reference, input: quoted('query', q),
  });

  // The results themselves come from the normal catalogue query, which the browser runs with these
  // filters — real rows at the price this viewer is entitled to, never a list the model wrote.
  const category = categories.find(c => c.slug === a.category_slug) || null;
  const kind = category ? category.kind : (kinds.includes(a.kind) ? a.kind : null);
  return {
    filters: { kind, category: category?.slug || '', q: str(a.keywords).slice(0, 100) },
    explanation: str(a.explanation).slice(0, 300),
  };
}

// --- AI-3: plan my materials --------------------------------------------------------

async function estimate(db, req, account, d) {
  const text = readText(d.text, 1500, 'project');
  const products = await db.query(
    `SELECT p.*, c.name AS category_name, un.label AS unit_label, un.plural AS unit_plural
       FROM mb_products p
       JOIN mb_categories c ON c.id = p.category_id
       LEFT JOIN mb_units un ON un.code = p.unit
      WHERE p.is_active AND p.stock_status <> 'out_of_stock'
      ORDER BY p.kind, c.name, p.name`);
  if (!products.length) throw fail(409, 'There is nothing in the catalogue to plan with yet.');

  const schema = {
    type: 'object', additionalProperties: false,
    required: ['assumptions', 'lines', 'caveats'],
    properties: {
      assumptions: strings,
      lines: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['slug', 'qty', 'reason'],
          properties: { slug: { type: 'string' }, qty: { type: 'number' }, reason: { type: 'string' } },
        },
      },
      caveats: strings,
    },
  };
  // No prices in the reference: the model estimates quantities, the server prices them.
  const reference = ['Catalogue (slug — name — category — sold per — pack size — minimum order):',
    ...products.map(p => `- ${p.slug} — ${p.name} — ${p.category_name} — ${p.unit_label || p.unit}`
      + ` — ${p.pack_size ?? '-'} — ${Number(p.min_order_qty)}`)].join('\n');

  const { answer: a } = await runFeature(db, req, account, 'estimate', {
    schema, reference, input: quoted('project', text),
  });

  const bySlug = new Map(products.map(p => [p.slug, p]));
  const businessView = isApprovedBusiness(account);
  const seen = new Set();
  const lines = [];
  let dropped = 0;
  let totalPaise = 0;
  for (const l of Array.isArray(a.lines) ? a.lines : []) {
    const p = bySlug.get(str(l.slug));
    const asked = Number(l.qty);
    // C1, rule 3: the model may only name products that exist and are live; anything else is
    // dropped before the customer sees it, and counted so the screen can say so.
    if (!p || seen.has(p.slug) || !Number.isFinite(asked) || asked <= 0 || lines.length >= 30) { dropped++; continue; }
    seen.add(p.slug);
    const min = Number(p.min_order_qty) || 1;
    const qty = Math.max(min, Math.ceil(asked * 1000) / 1000);
    const line = { slug: p.slug, name: p.name, unit: p.unit_label || p.unit, qty, reason: str(l.reason).slice(0, 240),
      roundedUp: qty > asked, unitPriceLabel: null, totalLabel: null, total: null };
    if (p.pricing_mode === 'fixed') {
      const priced = priceLine(p, qty, businessView);   // the one place a line is priced (D-26)
      totalPaise += priced.lineTotal;
      Object.assign(line, {
        unitPriceLabel: formatInr(priced.unitExcl), total: fromPaise(priced.lineTotal),
        totalLabel: formatInr(priced.lineTotal),
      });
    }
    lines.push(line);
  }

  return {
    assumptions: (a.assumptions || []).map(str).filter(Boolean).slice(0, 12),
    caveats: (a.caveats || []).map(str).filter(Boolean).slice(0, 12),
    lines,
    dropped,
    total: fromPaise(totalPaise),
    totalLabel: formatInr(totalPaise),
    businessPricing: businessView,
  };
}

// --- AI-4: translate a message ------------------------------------------------------

async function translate(db, req, account, d) {
  const lk = await lookups(db);
  const languages = lk.lookup.language || [];
  const target = languages.find(x => x.code === str(d.language));
  if (!target) throw fail(400, 'Choose a language to translate into.');

  // Only a participant reaches the message — scoped in the query, 404 for anyone else (NFR-21),
  // the same rule as reading it. An admin is refused before this by allowed_roles.
  const [msg] = account ? await db.query(
    `SELECT m.body FROM mb_messages m JOIN mb_conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND (c.customer_id = $2 OR c.owner_id = $2)`, [str(d.messageId), account.id]) : [];
  if (account && !isAdmin(account) && !msg) throw fail(404, 'That message was not found.');

  const schema = {
    type: 'object', additionalProperties: false,
    required: ['translation', 'detected_language'],
    properties: { translation: { type: 'string' }, detected_language: { type: 'string' } },
  };
  const { answer: a } = await runFeature(db, req, account, 'translate', {
    schema,
    input: `Translate into ${target.label} (language code ${target.code}).\n` + quoted('message', msg?.body || ''),
  });
  return { translation: str(a.translation), detectedLanguage: str(a.detected_language), language: target.code };
}

// --- AI-5: advise on an offer --------------------------------------------------------

async function offerAdvice(db, req, account, d) {
  const lk = await lookups(db);
  // The owner's own offers only, scoped in the query (NFR-20); someone else's is a 404 (NFR-21).
  const [bid] = account ? await db.query(
    `SELECT b.*, p.name AS product_name, p.unit, p.price_retail, p.price_business, p.min_order_qty
       FROM mb_bids b JOIN mb_products p ON p.id = b.product_id
      WHERE b.id = $1 AND b.owner_id = $2`, [str(d.bidId), account.id]) : [];
  if (account?.role === 'owner' && !bid) throw fail(404, 'That offer was not found.');
  if (bid) {
    const open = lk.bidStatuses.filter(s => s.is_open).map(s => s.code);
    if (!open.includes(bid.status)) throw fail(409, 'That offer is settled; there is nothing to advise on.');
  }

  // NFR-30: nothing about the buyer beyond what they offered — no name, no contact, no address.
  const moves = bid ? await db.query(
    `SELECT action, to_price, actor_id, created_at FROM mb_bid_moves WHERE bid_id = $1 ORDER BY created_at`,
    [bid.id]) : [];
  const [sales] = bid ? await db.query(
    `SELECT count(DISTINCT o.id)::int AS orders, COALESCE(sum(i.qty), 0) AS qty,
            CASE WHEN sum(i.qty) > 0 THEN round(sum(i.line_excl) / sum(i.qty), 2) END AS avg_unit_excl
       FROM mb_order_items i JOIN mb_orders o ON o.id = i.order_id
      WHERE o.owner_id = $1 AND i.product_id = $2 AND o.status <> 'cancelled'
        AND o.placed_at > now() - interval '90 days'`, [account.id, bid.product_id]) : [{}];

  const offer = bid ? [
    `Item: ${bid.product_name}, sold per ${bid.unit}. Minimum order ${Number(bid.min_order_qty)}.`,
    `Listed retail price: ${bid.price_retail ?? 'on request'} rupees excluding GST.`,
    `Listed trade price: ${bid.price_business ?? 'none'}.`,
    `Quantity offered for: ${Number(bid.qty)}.`,
    `Current price on the table: ${bid.unit_price ?? 'none yet (a request for a quote)'}.`,
    `It is the ${bid.turn === 'owner' ? "seller's" : "buyer's"} turn.`,
    'History:',
    ...moves.map(m => `- ${m.actor_id === account.id ? 'seller' : m.actor_id ? 'buyer' : 'system'} ${m.action}`
      + (m.to_price != null ? ` at ${m.to_price}` : '')),
    `Seller's own sales of this item in the last 90 days: ${sales.orders || 0} orders,`
      + ` ${Number(sales.qty || 0)} units, average ${sales.avg_unit_excl ?? 'n/a'} rupees per unit excluding GST.`,
  ].join('\n') : '';

  const schema = {
    type: 'object', additionalProperties: false,
    required: ['recommendation', 'suggested_unit_price', 'reasoning'],
    properties: {
      recommendation: { type: 'string', enum: ['accept', 'counter', 'reject'] },
      suggested_unit_price: nullable({ type: 'number' }),
      reasoning: { type: 'string' },
    },
  };
  const { answer: a } = await runFeature(db, req, account, 'offer_advice', {
    schema, input: quoted('offer', offer),
  });

  const price = a.recommendation === 'counter' ? money(a.suggested_unit_price) : null;
  return {
    advice: {
      recommendation: a.recommendation,
      suggestedUnitPrice: price != null ? price.toFixed(2) : null,
      suggestedUnitPriceLabel: price != null ? formatInr(toPaise(price.toFixed(2))) : null,
      reasoning: str(a.reasoning).slice(0, 600),
    },
  };
}

const FEATURES = {
  listing_draft: listingDraft,
  smart_search: smartSearch,
  estimate,
  translate,
  offer_advice: offerAdvice,
};

// --- AI-6: settings ------------------------------------------------------------------

async function settings(db) {
  const lk = await lookups(db);
  const rows = await loadFeatures(db);
  const usage = await usageSummary(db, 7);
  const price = model => lk.meta('ai_model', model) || {};
  return {
    configured: aiConfigured(),
    features: rows.map(r => ({
      feature: r.feature, label: r.label, description: r.description, enabled: r.enabled,
      model: r.model, effort: r.effort, maxTokens: r.max_tokens, systemPrompt: r.system_prompt,
      allowedRoles: r.allowed_roles, allowVisitors: r.allow_visitors,
      dailyLimitPerUser: r.daily_limit_per_user, dailyLimitTotal: r.daily_limit_total,
      updatedAt: r.updated_at,
    })),
    // Cost is an estimate from the listed price in mb_lookups, not a bill; cache writes and reads
    // are priced at the usual 1.25x and 0.1x of input.
    usage: usage.map(u => {
      const p = price(u.model);
      const usd = p.input == null ? null
        : (u.input_tokens * p.input + u.cache_write_tokens * p.input * 1.25
          + u.cache_read_tokens * p.input * 0.1 + u.output_tokens * p.output) / 1e6;
      return { ...u, estimatedUsd: usd == null ? null : Math.round(usd * 10000) / 10000 };
    }),
    models: lk.lookup.ai_model || [],
    efforts: lk.lookup.ai_effort || [],
  };
}

async function saveSetting(db, account, d) {
  const lk = await lookups(db);
  const [row] = await db.query('SELECT * FROM mb_ai_features WHERE feature = $1', [str(d.feature)]);
  if (!row) return { status: 404, body: { error: 'That AI feature does not exist.' } };

  const models = (lk.lookup.ai_model || []).map(x => x.code);
  const efforts = (lk.lookup.ai_effort || []).map(x => x.code);
  const next = {
    enabled: d.enabled == null ? row.enabled : !!d.enabled,
    model: d.model == null ? row.model : str(d.model),
    effort: d.effort == null ? row.effort : str(d.effort),
    max_tokens: d.maxTokens == null ? row.max_tokens : Number(d.maxTokens),
    daily_limit_per_user: d.dailyLimitPerUser === undefined ? row.daily_limit_per_user
      : (d.dailyLimitPerUser === null || d.dailyLimitPerUser === '' ? null : Number(d.dailyLimitPerUser)),
    daily_limit_total: d.dailyLimitTotal === undefined ? row.daily_limit_total
      : (d.dailyLimitTotal === null || d.dailyLimitTotal === '' ? null : Number(d.dailyLimitTotal)),
    system_prompt: d.systemPrompt == null ? row.system_prompt : String(d.systemPrompt),
  };
  if (!models.includes(next.model)) return { status: 400, body: { error: `"${next.model}" is not one of the models on offer.` } };
  if (!efforts.includes(next.effort)) return { status: 400, body: { error: 'Choose an effort level from the list.' } };
  if (!Number.isInteger(next.max_tokens) || next.max_tokens < 1024 || next.max_tokens > 64000) {
    return { status: 400, body: { error: 'Max tokens must be a whole number from 1024 to 64000.' } };
  }
  for (const k of ['daily_limit_per_user', 'daily_limit_total']) {
    if (next[k] != null && (!Number.isInteger(next[k]) || next[k] < 1)) {
      return { status: 400, body: { error: 'A daily limit is a whole number of 1 or more, or empty for none.' } };
    }
  }
  if (!next.system_prompt.trim()) return { status: 400, body: { error: 'The instructions cannot be empty.' } };
  if (next.system_prompt.length > 8000) return { status: 400, body: { error: 'Keep the instructions under 8000 characters.' } };

  const [saved] = await db.query(
    `UPDATE mb_ai_features SET enabled = $2, model = $3, effort = $4, max_tokens = $5,
            daily_limit_per_user = $6, daily_limit_total = $7, system_prompt = $8,
            updated_at = now(), updated_by = $9
      WHERE feature = $1 RETURNING feature, enabled, model, effort, max_tokens,
            daily_limit_per_user, daily_limit_total, updated_at`,
    [row.feature, next.enabled, next.model, next.effort, next.max_tokens,
     next.daily_limit_per_user, next.daily_limit_total, next.system_prompt, account.id]);
  return { status: 200, body: { feature: saved } };
}

// --- handler ---------------------------------------------------------------------------

export async function handle(req, res, db) {
  const q = new URL(req.url, 'https://local').searchParams;
  const account = await sessionAccount(req, db);

  if (req.method === 'GET') {
    if (q.get('resource') === 'features') {
      // Which buttons to draw. No instructions, no limits, no models — only what this caller may use.
      res.setHeader('Cache-Control', 'private, max-age=60');
      const rows = await loadFeatures(db);
      const configured = aiConfigured();
      return json(res, 200, {
        configured,
        features: rows.map(r => ({
          feature: r.feature, label: r.label,
          available: configured && mayUse(r, account),
        })),
      });
    }
    if (q.get('resource') === 'settings') {
      requireAdmin(account);
      return json(res, 200, await settings(db));
    }
    return json(res, 400, { error: 'Unknown resource.' });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  if (q.get('resource') === 'settings') {
    requireAdmin(account);
    if (q.get('action') !== 'save') return json(res, 400, { error: 'Unknown action.' });
    const out = await saveSetting(db, account, await body(req));
    return json(res, out.status, out.body);
  }

  const run = FEATURES[q.get('feature')];
  if (!run) return json(res, 404, { error: 'That AI feature does not exist.' });
  res.setHeader('Cache-Control', 'private, no-store');
  return json(res, 200, await run(db, req, account, await body(req)));
}

export default async function handler(req, res) {
  try {
    return await handle(req, res, defaultDb);
  } catch (e) {
    if (e?.status) return json(res, e.status, { error: e.message });
    // Code and message only — never the request, never the answer (NFR-24, NFR-31).
    console.error('matbyus ai failure:', e?.code || '', e?.message || 'unknown error');
    if (e?.code === 'CONFIG') return json(res, 503, { error: 'AI is not configured: ' + e.message });
    return json(res, 500, { error: 'Server error.' });
  }
}
