// Recovery for a locked-out admin (FR-4.4). Sets a password and raises session_version, which
// signs out every existing session for that account.
//
// Usage:  MB_NEW_PASSWORD='...' node scripts/admin/reset-password.mjs <email>

import { neon } from '@neondatabase/serverless';
import { hash, passwordProblem, validEmail, normaliseEmail } from '../../api/_lib.js';

const email = normaliseEmail(process.argv[2]);
const password = process.env.MB_NEW_PASSWORD || '';
const die = m => { console.error(m); process.exit(1); };

if (!process.env.DATABASE_URL) die('DATABASE_URL is not set.');
if (!validEmail(email)) die('Usage: MB_NEW_PASSWORD=\'...\' node scripts/admin/reset-password.mjs <email>');

const problem = passwordProblem(password);
if (problem) die('MB_NEW_PASSWORD: ' + problem);

const sql = neon(process.env.DATABASE_URL);
const rows = await sql.query(
  `UPDATE mb_users SET password_hash = $1, session_version = session_version + 1, updated_at = now()
   WHERE email = $2 RETURNING email, role, session_version`,
  [hash(password), email]);

if (!rows.length) die(`No account was found for ${email}.`);
console.log(`Password reset for ${rows[0].email} (${rows[0].role}). Existing sessions signed out.`);
