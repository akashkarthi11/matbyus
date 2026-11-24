// matbyus — database access. TSD section 1.
// One `query(text, params)` surface so handlers can be given a different database in tests
// (PGlite) without the production path changing shape.

import { neon } from '@neondatabase/serverless';
import { configError } from './_lib.js';

let client = null;

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw configError('DATABASE_URL is not set');
  if (!client) client = neon(url);
  return client;
}

export const db = {
  async query(text, params = []) {
    const sql = connect();
    return sql.query(text, params);
  },
};
