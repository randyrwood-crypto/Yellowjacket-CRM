const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function isAdmin(req) {
  return req.session.user.role === 'admin';
}

// GET /api/accounts/names — every account name, to ANY signed-in user
// (not scoped to their own leads). This has to be unscoped: it's what
// powers the "type an account name" autocomplete on the lead form, and a
// salesman needs to be able to match a company another salesman already
// has on file — otherwise the whole point of consolidating accounts is
// defeated by everyone creating their own duplicate.
router.get('/names', async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT id, name FROM accounts ORDER BY name ASC`);
    res.json({ accounts: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts?salesman_id=3 — one row per account with rolled-up
// totals across ALL of that account's leads (every period, not just the
// current month — Accounts is a persistent, cross-time view; Archive is
// still there for browsing month by month). A salesman only sees accounts
// where they have at least one lead, and the totals only count their own
// leads; admins see everyone, optionally filtered to one salesman.
router.get('/', async (req, res, next) => {
  try {
    // scopedSalesmanId is null for an admin viewing everyone; set for a
    // salesman (forced to themselves) or an admin filtering to one person.
    let scopedSalesmanId = null;
    if (!isAdmin(req)) {
      scopedSalesmanId = req.session.user.id;
    } else if (req.query.salesman_id) {
      scopedSalesmanId = Number(req.query.salesman_id);
    }
    // Same scope value used three times (the lead join, the wins subquery,
    // and the "does this salesman have any lead here at all" check) — $1
    // throughout, and a plain NULL check for "no scoping" so one query
    // covers both the admin (see everyone) and salesman/filtered cases.
    const params = [scopedSalesmanId];

    const result = await pool.query(
      `SELECT a.id, a.name, a.contact, a.phone, a.email,
         count(l.id)::int AS lead_count,
         coalesce(sum(l.deal_value),0)::numeric AS pipeline_value,
         coalesce((
           SELECT sum(lw.amount) FROM lead_wins lw
           JOIN leads l2 ON l2.id = lw.lead_id
           WHERE l2.account_id = a.id AND ($1::int IS NULL OR l2.salesman_id = $1)
         ),0)::numeric AS won_to_date
       FROM accounts a
       LEFT JOIN leads l ON l.account_id = a.id AND ($1::int IS NULL OR l.salesman_id = $1)
       WHERE ($1::int IS NULL OR EXISTS (
         SELECT 1 FROM leads l3 WHERE l3.account_id = a.id AND l3.salesman_id = $1
       ))
       GROUP BY a.id
       ORDER BY a.name ASC`,
      params
    );
    res.json({ accounts: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts/:id/leads — every lead under this account, most recent
// first, across all periods (the whole point of the Accounts page is
// seeing a company's full history in one place). Scoped to the caller's
// own leads unless admin.
router.get('/:id/leads', async (req, res, next) => {
  try {
    const params = [req.params.id];
    let scope = '1=1';
    if (!isAdmin(req)) {
      params.push(req.session.user.id);
      scope = `leads.salesman_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT leads.id, leads.lead_code, leads.site, leads.county, leads.location,
         leads.service_type, leads.stage, leads.deal_value, leads.salesman_id,
         users.name AS salesman_name, leads.last_contact, leads.next_follow_up,
         leads.notes, leads.period, leads.created_at, leads.updated_at,
         COALESCE((SELECT sum(amount) FROM lead_wins WHERE lead_wins.lead_id = leads.id), 0) AS won_to_date
       FROM leads JOIN users ON users.id = leads.salesman_id
       WHERE leads.account_id = $1 AND ${scope}
       ORDER BY leads.created_at DESC`,
      params
    );
    res.json({ leads: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/accounts/:id — update the account's shared contact info (name
// is not editable here: it's how leads match to this account by name, so
// renaming is left out for now to avoid orphaning future matches).
// Admins can edit any account; a salesman can edit one only if they have
// at least one lead under it, so a salesman with no relationship to a
// company can't rewrite its contact info.
router.put('/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) {
      const owns = await pool.query(
        `SELECT 1 FROM leads WHERE account_id = $1 AND salesman_id = $2 LIMIT 1`,
        [req.params.id, req.session.user.id]
      );
      if (!owns.rows.length) return res.status(403).json({ error: 'not_yours' });
    }
    const body = req.body || {};
    const result = await pool.query(
      `UPDATE accounts SET contact=$1, phone=$2, email=$3, updated_at=now()
       WHERE id=$4 RETURNING id, name, contact, phone, email`,
      [body.contact || '', body.phone || '', body.email || '', req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ account: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
