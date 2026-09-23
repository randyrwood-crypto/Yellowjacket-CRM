// Applies db/schema.sql. Safe to run every deploy — everything in the
// schema is CREATE ... IF NOT EXISTS, so re-running it is a no-op once the
// tables already exist.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema applied.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
