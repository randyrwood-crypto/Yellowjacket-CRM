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

-- An Account is one company/customer — the persistent record a customer's
-- leads are grouped under, so the same company's history lives in one
-- place instead of scattered, disconnected lead rows. "company" on leads
-- above is kept only as a historical snapshot column (never dropped, for
-- safety); the app reads company/contact/phone/email through the account
-- from here on.
CREATE TABLE IF NOT EXISTS accounts (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  contact     TEXT DEFAULT '',
  phone       TEXT DEFAULT '',
  email       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id);
CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);

-- Consolidate any leads created before Accounts existed: one Account per
-- distinct company name, carrying over that company's contact/phone/email.
-- Guarded on both ends (NOT EXISTS + account_id IS NULL) so re-running this
-- migration never creates a duplicate account or reassigns an already-set
-- lead.
INSERT INTO accounts (name, contact, phone, email)
SELECT DISTINCT ON (leads.company) leads.company, leads.contact, leads.phone, leads.email
FROM leads
WHERE leads.account_id IS NULL
  AND leads.company IS NOT NULL AND leads.company <> ''
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE accounts.name = leads.company)
ORDER BY leads.company, leads.updated_at DESC
ON CONFLICT (name) DO NOTHING;

UPDATE leads SET account_id = accounts.id
FROM accounts
WHERE accounts.name = leads.company AND leads.account_id IS NULL;

-- Assignments: an admin-directed prospecting task — "go after this target
-- account" — with an optional target date, notes on potential contacts,
-- and free-form notes on what's needed. account_id resolves through the
-- same accounts table leads use (match-or-create by name), so a target can
-- be a brand-new prospect (the account is created on the spot) or an
-- existing account the admin wants worked further.
CREATE SEQUENCE IF NOT EXISTS assignment_code_seq START 1;

CREATE TABLE IF NOT EXISTS assignments (
  id               SERIAL PRIMARY KEY,
  assignment_code  TEXT NOT NULL UNIQUE,           -- e.g. AS-0001
  account_id       INTEGER NOT NULL REFERENCES accounts(id),
  account_name     TEXT NOT NULL,                  -- snapshot at assignment time
  target_date      DATE,
  contact_info     TEXT DEFAULT '',                 -- admin's notes on potential contacts
  notes            TEXT DEFAULT '',                 -- admin's free-form "what's needed" notes
  salesman_id      INTEGER NOT NULL REFERENCES users(id),
  assigned_by      INTEGER NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','responded')),
  response_text    TEXT DEFAULT '',
  responded_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assignments_salesman ON assignments(salesman_id);
CREATE INDEX IF NOT EXISTS idx_assignments_account ON assignments(account_id);

-- Notifications: lightweight in-app alerts for the bell icon in the rail.
-- Deliberately NOT a read/unread flag — see routes/notifications.js — a
-- notification is deleted the moment it's fetched for viewing, which is
-- what makes it "disappear" once opened, as requested.
CREATE TABLE IF NOT EXISTS notifications (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL,                      -- 'assignment_new' | 'assignment_response'
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

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
  period                  TEXT,                    -- 'YYYY-MM' logged in; drives Lost Opps vs Archive
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lost_salesman ON lost_opportunities(salesman_id);

-- For databases that already had this table before monthly archiving was
-- added: add the column if it's missing, backfill any existing rows to the
-- current month (so nothing already logged disappears), then lock it down.
ALTER TABLE lost_opportunities ADD COLUMN IF NOT EXISTS period TEXT;
UPDATE lost_opportunities SET period = to_char(now(), 'YYYY-MM') WHERE period IS NULL;
ALTER TABLE lost_opportunities ALTER COLUMN period SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lost_period ON lost_opportunities(period);

-- A "win" is a dollar amount a salesman logs against a lead — it does NOT
-- change the lead's stage, so partial wins can be logged over time on a
-- deal that's still open (e.g. a customer commits to part of the work now,
-- the rest later). The dashboard's Won total is the sum of these entries
-- for the period, not just leads whose stage happens to say "Won".
CREATE TABLE IF NOT EXISTS lead_wins (
  id          SERIAL PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL,
  note        TEXT DEFAULT '',
  salesman_id INTEGER NOT NULL REFERENCES users(id),
  period      TEXT NOT NULL,           -- 'YYYY-MM' the win was logged in (drives the dashboard's Won total)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_wins_lead ON lead_wins(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_wins_period ON lead_wins(period);
CREATE INDEX IF NOT EXISTS idx_lead_wins_salesman ON lead_wins(salesman_id);

-- Backfill: any lead already marked Won with a deal value, from before this
-- win-tracking table existed, gets one matching win entry so its revenue
-- isn't suddenly missing from the dashboard's Won total. Guarded so it only
-- ever runs once per lead.
INSERT INTO lead_wins (lead_id, amount, note, salesman_id, period, created_at)
SELECT leads.id, leads.deal_value, 'Migrated automatically from this lead''s Won stage.',
       leads.salesman_id, leads.period, leads.updated_at
FROM leads
WHERE leads.stage = 'Won' AND leads.deal_value > 0
  AND NOT EXISTS (SELECT 1 FROM lead_wins WHERE lead_wins.lead_id = leads.id);

-- Session store for connect-pg-simple (it will also create this itself if
-- missing, but declaring it here keeps one place that owns the schema).
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
