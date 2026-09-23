// Auto-creates (or resets the password for) the admin account from environment
// variables, so it can run as part of the Render Start Command — no Shell
// access required (Shell is a paid-plan-only feature on Render).
//
// Reads ADMIN_NAME and ADMIN_PASSWORD from the environment. If either is
// missing, it just logs a message and exits cleanly without touching
// anything or failing the deploy.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

async function main() {
  const name = process.env.ADMIN_NAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!name || !password) {
    console.log('ADMIN_NAME / ADMIN_PASSWORD not set — skipping admin auto-seed.');
    await pool.end();
    return;
  }
  if (password.length < 8) {
    console.log('ADMIN_PASSWORD must be at least 8 characters — skipping admin auto-seed.');
    await pool.end();
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO users (name, password_hash, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'
     RETURNING id, name, role`,
    [name, hash]
  );
  console.log('Admin ready:', result.rows[0]);
  await pool.end();
}

main().catch((err) => {
  // Log but don't fail the deploy over this step — the app should still
  // start even if, say, ADMIN_PASSWORD was too short or a typo occurred.
  console.error('Admin auto-seed failed (app will still start):', err.message);
});
