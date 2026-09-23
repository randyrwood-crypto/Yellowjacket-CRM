const { Pool } = require('pg');

// Render's managed Postgres requires SSL for external/most internal
// connections; local development (no DATABASE_URL set to a remote host)
// doesn't need it. DATABASE_URL is provided automatically by Render when
// you attach a Postgres database to this web service (see README).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env for local dev, ' +
    'or attach a Postgres database to this service on Render.'
  );
}

const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

module.exports = pool;
