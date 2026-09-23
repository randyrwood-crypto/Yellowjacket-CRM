// Creates (or resets the password for) the first admin account.
// Usage:  node scripts/seed-admin.js "Randy Wood" "some-password"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

async function main() {
  const [name, password] = process.argv.slice(2);
  if (!name || !password) {
    console.error('Usage: node scripts/seed-admin.js "Full Name" "password"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
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
  console.error('Failed to seed admin:', err);
  process.exit(1);
});
