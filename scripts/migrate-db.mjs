// Applies pending migrations in filename order. Forward-only; an applied file is never edited.
// Usage:  node scripts/migrate-db.mjs [--dry-run]

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'migrations');
const dry = process.argv.includes('--dry-run');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');     // the name, never the value
  process.exit(1);
}
const sql = neon(url);

// Neon's HTTP driver sends one prepared statement per call, so a migration file has to be split.
// Splitting on ';' alone would break the moment a migration contains a semicolon inside a string,
// a comment or a dollar-quoted function body, so this walks the text properly.
export function splitStatements(text) {
  const out = [];
  let buf = '', i = 0;
  while (i < text.length) {
    const c = text[i], two = text.slice(i, i + 2);
    if (two === '--') {                                   // line comment
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (two === '/*') {                                   // block comment
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {                         // quoted literal or identifier
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === c) { if (text[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      buf += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(text.slice(i));  // dollar-quoted body
    if (dollar) {
      const tag = dollar[0];
      const end = text.indexOf(tag, i + tag.length);
      const stop = end === -1 ? text.length : end + tag.length;
      buf += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ';') { out.push(buf.trim()); buf = ''; i++; continue; }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

await sql.query(`CREATE TABLE IF NOT EXISTS mb_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);

const applied = new Set((await sql.query('SELECT filename FROM mb_migrations')).map(r => r.filename));
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const pending = files.filter(f => !applied.has(f));

if (!pending.length) {
  console.log(`Up to date. ${files.length} migration${files.length === 1 ? '' : 's'} already applied.`);
  process.exit(0);
}

console.log(`${pending.length} pending: ${pending.join(', ')}`);
if (dry) process.exit(0);

// Statements run one at a time, so a file that fails part-way leaves the statements before the
// failure applied. Every migration is therefore written to be re-runnable (CREATE ... IF NOT
// EXISTS), and a file is only recorded once all of its statements have succeeded.
for (const f of pending) {
  const statements = splitStatements(readFileSync(join(dir, f), 'utf8'));
  process.stdout.write(`  applying ${f} (${statements.length} statements) ... `);
  let n = 0;
  try {
    for (const s of statements) { await sql.query(s); n++; }
    await sql.query('INSERT INTO mb_migrations (filename) VALUES ($1)', [f]);
    console.log('done');
  } catch (e) {
    console.log('FAILED');
    console.error(`  statement ${n + 1} of ${statements.length}: ${statements[n].split('\n')[0].slice(0, 90)}`);
    console.error(`  ${e.message}`);
    console.error(`  ${n} statement${n === 1 ? '' : 's'} before it were applied. The file was not recorded,`);
    console.error('  so re-running after the fix will replay it; every statement is written to be re-runnable.');
    process.exit(1);
  }
}
console.log('All migrations applied.');
