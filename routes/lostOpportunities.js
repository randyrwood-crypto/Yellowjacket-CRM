const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function currentPeriod() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function isAdmin(req) {
  return req.session.user.role === 'admin';
}

const SELECT_COLS = `
  lo.id, lo.lost_code, lo.company, lo.contact, lo.service_type, lo.reason,
  lo.potential_revenue_loss, lo.salesman_id, users.name AS salesman_name,
  lo.notes, lo.period, lo.created_at, lo.updated_at
`;

// GET /api/lost-opportunities?period=2026-09  (defaults to the current
// period; "all" for every period) — same rollover pattern as /api/leads.
router.get('/', async (req, res, next) => {
  try {
    const period = req.query.period || currentPeriod();
    const params = [];
    let where = '1=1';
    if (period !== 'all') {
      params.push(period);
      where += ` AND lo.period = $${params.length}`;
    }
    if (!isAdmin(req)) {
      params.push(req.session.user.id);
      where += ` AND lo.salesman_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT ${SELECT_COLS} FROM lost_opportunities lo JOIN users ON users.id = lo.salesman_id
       WHERE ${where} ORDER BY lo.created_at DESC`,
      params
    );
    res.json({ lostOpportunities: result.rows, currentPeriod: currentPeriod() });
  } catch (err) {
    next(err);
  }
});

// GET /api/lost-opportunities/periods — distinct past periods, for Archive.
router.get('/periods', async (req, res, next) => {
  try {
    const params = [];
    let where = `period <> $1`;
    params.push(currentPeriod());
    if (!isAdmin(req)) {
      params.push(req.session.user.id);
      where += ` AND salesman_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT DISTINCT period FROM lost_opportunities WHERE ${where} ORDER BY period DESC`,
      params
    );
    res.json({ periods: result.rows.map((r) => r.period) });
  } catch (err) {
    next(err);
  }
});

async function getLostOr404(req, res) {
  const result = await pool.query(
    `SELECT ${SELECT_COLS} FROM lost_opportunities lo JOIN users ON users.id = lo.salesman_id WHERE lo.id = $1`,
    [req.params.id]
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return row;
}

// GET /api/lost-opportunities/:id — single record, for the read-only View
// screen. A salesman may only view their own; admin may view any.
router.get('/:id', async (req, res, next) => {
  try {
    const row = await getLostOr404(req, res);
    if (!row) return;
    if (!isAdmin(req) && row.salesman_id !== req.session.user.id) {
      return res.status(403).json({ error: 'not_yours' });
    }
    res.json({ lostOpportunity: row });
  } catch (err) {
    next(err);
  }
});

// POST /api/lost-opportunities — create. Salesmen are always tagged with
// their own id, regardless of what (if anything) is sent for salesman_id.
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.company || !String(body.company).trim()) {
      return res.status(400).json({ error: 'validation', details: ['Company is required.'] });
    }
    let salesmanId = req.session.user.id;
    if (isAdmin(req) && body.salesman_id) salesmanId = Number(body.salesman_id);

    const codeResult = await pool.query(`SELECT nextval('lost_code_seq') AS n`);
    const lostCode = 'LO-' + String(codeResult.rows[0].n).padStart(4, '0');

    const result = await pool.query(
      `INSERT INTO lost_opportunities
        (lost_code, company, contact, service_type, reason, potential_revenue_loss, salesman_id, notes, period)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        lostCode, body.company, body.contact || '', body.service_type || '',
        body.reason || '', Number(body.potential_revenue_loss) || 0, salesmanId, body.notes || '',
        currentPeriod(),
      ]
    );
    req.params.id = result.rows[0].id;
    const row = await getLostOr404(req, res);
    res.status(201).json({ lostOpportunity: row });
  } catch (err) {
    next(err);
  }
});

// PUT /api/lost-opportunities/:id — update. A salesman may edit only their
// own record, and may never reassign it; admins may edit anything,
// including reassigning the salesman. (Deleting stays admin-only, below.)
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await getLostOr404(req, res);
    if (!existing) return;
    if (!isAdmin(req) && existing.salesman_id !== req.session.user.id) {
      return res.status(403).json({ error: 'not_yours' });
    }

    const body = req.body || {};
    if (!body.company || !String(body.company).trim()) {
      return res.status(400).json({ error: 'validation', details: ['Company is required.'] });
    }

    let salesmanId = existing.salesman_id;
    if (isAdmin(req) && body.salesman_id) {
      salesmanId = Number(body.salesman_id);
    }

    await pool.query(
      `UPDATE lost_opportunities SET
        company=$1, contact=$2, service_type=$3, reason=$4, potential_revenue_loss=$5,
        salesman_id=$6, notes=$7, updated_at=now()
       WHERE id=$8`,
      [body.company, body.contact || '', body.service_type || '', body.reason || '',
       Number(body.potential_revenue_loss) || 0, salesmanId, body.notes || '', req.params.id]
    );
    const row = await getLostOr404(req, res);
    res.json({ lostOpportunity: row });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/lost-opportunities/:id — admin only. Salesmen can log and
// now edit their own lost opportunities, but only an admin can remove one.
router.delete('/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    await pool.query(`DELETE FROM lost_opportunities WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
