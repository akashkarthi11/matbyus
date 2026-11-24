// Creates the first admin. Operator-run against the target database, never reachable over HTTP —
// there is no shared registration key and no way to become an admin through the API (FSD V1, FR-1.5).
//
// Usage:  MB_ADMIN_PASSWORD='...' node scripts/admin/create-admin.mjs <email> <mobile> "<full name>"
//
// The password comes from the environment so it does not land in shell history or a process list.

import { neon } from '@neondatabase/serverless';
import { hash, passwordProblem, validEmail, normaliseEmail } from '../../api/_lib.js';
import { normaliseMobile } from '../../api/_india.js';

const [emailArg, mobileArg, nameArg] = process.argv.slice(2);
const password = process.env.MB_ADMIN_PASSWORD || '';

const die = m => { console.error(m); process.exit(1); };

if (!process.env.DATABASE_URL) die('DATABASE_URL is not set.');
if (!emailArg || !mobileArg) {
  die('Usage: MB_ADMIN_PASSWORD=\'...\' node scripts/admin/create-admin.mjs <email> <mobile> "<full name>"');
}

const email = normaliseEmail(emailArg);
if (!validEmail(email)) die('That is not a valid email address.');

const phone = normaliseMobile(mobileArg);
if (!phone) die('That is not a valid Indian mobile number.');

const problem = passwordProblem(password);
if (problem) die('MB_ADMIN_PASSWORD: ' + problem);

const sql = neon(process.env.DATABASE_URL);
const rows = await sql.query(
  `INSERT INTO mb_users (email, password_hash, full_name, phone, role, account_type, business_status)
   VALUES ($1, $2, $3, $4, 'admin', 'individual', 'none')
   ON CONFLICT (email) DO NOTHING
   RETURNING id, email, role`,
  [email, hash(password), (nameArg || '').trim() || null, phone]);

if (!rows.length) die(`An account already exists for ${email}. Use reset-password.mjs instead.`);
console.log(`Admin created: ${rows[0].email}`);     // never the password or the hash
