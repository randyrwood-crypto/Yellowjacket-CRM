const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function isAdmin(req) {
  return req.session.user.role === 'admin';
}

const SELECT_COLS = `
  lo.id, lo.lost_code, lo.company, lo.contact, lo.service_type, lo.reason,
  lo.potential_revenue_loss, lo.salesman_id, users.name AS salesman_name,
  lo.notes, lo.created_at, lo.updated_at
`;

router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = '1=1';
    if (!isAdmin(req)) {
      params.push(req.session.user.id);
      where += ` AND lo.salesman_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT ${SELECT_COLS} FROM lost_opportunities lo JOIN users ON users.id = lo.salesman_id
       WHERE ${where} ORDER BY lo.created_at DESC`,
      params
    );
    res.json({ lostOpportunities: result.rows });
  } catch (err) {
    next(err);
  }
});

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
        (lost_code, company, contact, service_type, reason, potential_revenue_loss, salesman_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        lostCode, body.company, body.contact || '', body.service_type || '',
        body.reason || '', Number(body.potential_revenue_loss) || 0, salesmanId, body.notes || '',
      ]
    );
    const row = await pool.query(
      `SELECT ${SELECT_COLS} FROM lost_opportunities lo JOIN users ON users.id = lo.salesman_id WHERE lo.id = $1`,
      [result.rows[0].id]
    );
    res.status(201).json({ lostOpportunity: row.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Editing and deleting lost opportunities stays admin-only, same as the
// original CRM — salesmen can log and view them but not change history.
router.put('/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    const body = req.body || {};
    if (!body.company || !String(body.company).trim()) {
      return res.status(400).json({ error: 'validation', details: ['Company is required.'] });
    }
    let salesmanId = body.salesman_id ? Number(body.salesman_id) : null;
    if (!salesmanId) {
      const existing = await pool.query(`SELECT salesman_id FROM lost_opportunities WHERE id=$1`, [req.params.id]);
      if (!existing.rows[0]) return res.status(404).json({ error: 'not_found' });
      salesmanId = existing.rows[0].salesman_id;
    }
    await pool.query(
      `UPDATE lost_opportunities SET
        company=$1, contact=$2, service_type=$3, reason=$4, potential_revenue_loss=$5,
        salesman_id=$6, notes=$7, updated_at=now()
       WHERE id=$8`,
      [body.company, body.contact || '', body.service_type || '', body.reason || '',
       Number(body.potential_revenue_loss) || 0, salesmanId, body.notes || '', req.params.id]
    );
    const row = await pool.query(
      `SELECT ${SELECT_COLS} FROM lost_opportunities lo JOIN users ON users.id = lo.salesman_id WHERE lo.id = $1`,
      [req.params.id]
    );
    if (!row.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ lostOpportunity: row.rows[0] });
  } catch (err) {
    next(err);
  }
});

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
