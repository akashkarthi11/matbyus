// Configuration and dependency check. Reports which settings are missing by NAME only — never a
// value, never a fragment of one (NFR-2).

import { json } from './_lib.js';
import { db } from './_db.js';

export default async function handler(req, res) {
  const secret = process.env.MB_SESSION_SECRET || '';
  const settings = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    MB_SESSION_SECRET: secret.trim().length >= 32,
    MB_SELLER_STATE_CODE: !!process.env.MB_SELLER_STATE_CODE,
    MB_SELLER_GSTIN: !!process.env.MB_SELLER_GSTIN,
    // Optional: without it the AI features are off and every other path runs (FSD Phase 3 NFR-33).
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN,
  };
  const required = ['DATABASE_URL', 'MB_SESSION_SECRET'];
  const missing = Object.entries(settings).filter(([, ok]) => !ok).map(([k]) => k);

  let database = 'unknown';
  if (settings.DATABASE_URL) {
    try {
      await db.query('SELECT 1');
      database = 'ok';
    } catch (e) {
      database = 'unreachable';
      console.error('matbyus health: database unreachable:', e?.message || 'unknown error');
    }
  } else {
    database = 'not configured';
  }

  const blocking = missing.filter(m => required.includes(m));
  const ok = blocking.length === 0 && database === 'ok';
  return json(res, ok ? 200 : 503, {
    ok,
    database,
    missing,                                   // names only
    blocking,
    note: blocking.length
      ? 'The storefront cannot run until the blocking settings are present.'
      : missing.length
        ? 'Running. The settings listed are optional: seller settings until invoicing, ANTHROPIC_API_KEY for the AI features.'
        : 'All settings present.',
  });
}
