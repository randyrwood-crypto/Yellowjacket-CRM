-- Yellowjacket Sales CRM — database schema
-- Safe to run more than once (IF NOT EXISTS everywhere).

CREATE SEQUENCE IF NOT EXISTS lead_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS lost_code_seq START 1;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','salesman')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id                SERIAL PRIMARY KEY,
  lead_code         TEXT NOT NULL UNIQUE,          -- e.g. YJ-0001
  company           TEXT NOT NULL,
  contact           TEXT DEFAULT '',
  phone             TEXT DEFAULT '',
  email             TEXT DEFAULT '',
  site              TEXT DEFAULT '',
  county            TEXT DEFAULT '',
  location          TEXT DEFAULT '',
  service_type      TEXT DEFAULT '',
  stage             TEXT NOT NULL DEFAULT 'New Lead',
  deal_value        NUMERIC NOT NULL DEFAULT 0,
  salesman_id       INTEGER NOT NULL REFERENCES users(id),
  last_contact      DATE,
  next_follow_up    DATE,
  notes             TEXT DEFAULT '',
  period            TEXT NOT NULL,                 -- 'YYYY-MM' the lead was created in; drives Leads vs Archive
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_salesman ON leads(salesman_id);
CREATE INDEX IF NOT EXISTS idx_leads_period ON leads(period);

CREATE TABLE IF NOT EXISTS lost_opportunities (
  id                      SERIAL PRIMARY KEY,
  lost_code               TEXT NOT NULL UNIQUE,    -- e.g. LO-0001
  company                 TEXT NOT NULL,
  contact                 TEXT DEFAULT '',
  service_type            TEXT DEFAULT '',
  reason                  TEXT DEFAULT '',
  potential_revenue_loss  NUMERIC NOT NULL DEFAULT 0,
  salesman_id             INTEGER NOT NULL REFERENCES users(id),
  notes                   TEXT DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lost_salesman ON lost_opportunities(salesman_id);

-- Session store for connect-pg-simple (it will also create this itself if
-- missing, but declaring it here keeps one place that owns the schema).
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
