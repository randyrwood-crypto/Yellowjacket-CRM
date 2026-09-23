const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const STAGES = ['New Lead', 'Contacted', 'Quoted', 'Negotiating', 'Won', 'Lost'];

function currentPeriod() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function isAdmin(req) {
  return req.session.user.role === 'admin';
}

// Row shape sent to the client; salesman_name is joined in.
const SELECT_COLS = `
  leads.id, leads.lead_code, leads.company, leads.contact, leads.phone, leads.email,
  leads.site, leads.county, leads.location, leads.service_type, leads.stage,
  leads.deal_value, leads.salesman_id, users.name AS salesman_name,
  leads.last_contact, leads.next_follow_up, leads.notes, leads.period,
  leads.created_at, leads.updated_at
`;

// GET /api/leads?period=2026-09   (defaults to the current period; "all" for every period)
router.get('/', async (req, res, next) => {
  try {
    const period = req.query.period || currentPeriod();
    const params = [];
    let where = '1=1';
    if (period !== 'all') {
      params.push(period);
      where += ` AND leads.period = $${params.length}`;
    }
    if (!isAdmin(req)) {
      params.push(req.session.user.id);
      where += ` AND leads.salesman_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT ${SELECT_COLS} FROM leads JOIN users ON users.id = leads.salesman_id
       WHERE ${where} ORDER BY leads.created_at DESC`,
      params
    );
    res.json({ leads: result.rows, currentPeriod: currentPeriod() });
  } catch (err) {
    next(err);
  }
});

// GET /api/leads/periods — distinct past periods for the Archive view
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
      `SELECT DISTINCT period FROM leads WHERE ${where} ORDER BY period DESC`,
      params
    );
    res.json({ periods: result.rows.map((r) => r.period) });
  } catch (err) {
    next(err);
  }
});

async function getLeadOr404(req, res) {
  const result = await pool.query(
    `SELECT ${SELECT_COLS} FROM leads JOIN users ON users.id = leads.salesman_id WHERE leads.id = $1`,
    [req.params.id]
  );
  const lead = result.rows[0];
  if (!lead) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return lead;
}

// GET /api/leads/:id
router.get('/:id', async (req, res, next) => {
  try {
    const lead = await getLeadOr404(req, res);
    if (!lead) return;
    if (!isAdmin(req) && lead.salesman_id !== req.session.user.id) {
      return res.status(403).json({ error: 'not_your_lead' });
    }
    res.json({ lead });
  } catch (err) {
    next(err);
  }
});

function validateBody(body) {
  const errors = [];
  if (!body.company || !String(body.company).trim()) errors.push('Company is required.');
  if (body.stage && !STAGES.includes(body.stage)) errors.push('Invalid stage.');
  return errors;
}

// POST /api/leads — create. Salesmen are always tagged with their own id,
// regardless of what (if anything) is sent for salesman_id — enforced here,
// not just hidden in the UI.
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const errors = validateBody(body);
    if (errors.length) return res.status(400).json({ error: 'validation', details: errors });

    let salesmanId = req.session.user.id;
    if (isAdmin(req) && body.salesman_id) {
      salesmanId = Number(body.salesman_id);
    }

    const codeResult = await pool.query(`SELECT nextval('lead_code_seq') AS n`);
    const leadCode = 'YJ-' + String(codeResult.rows[0].n).padStart(4, '0');

    const result = await pool.query(
      `INSERT INTO leads
        (lead_code, company, contact, phone, email, site, county, location,
         service_type, stage, deal_value, salesman_id, last_contact, next_follow_up,
         notes, period)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        leadCode, body.company, body.contact || '', body.phone || '', body.email || '',
        body.site || '', body.county || '', body.location || '', body.service_type || '',
        body.stage || 'New Lead', Number(body.deal_value) || 0, salesmanId,
        body.last_contact || null, body.next_follow_up || null, body.notes || '',
        currentPeriod(),
      ]
    );
    req.params.id = result.rows[0].id;
    const lead = await getLeadOr404(req, res);
    res.status(201).json({ lead });
  } catch (err) {
    next(err);
  }
});

// PUT /api/leads/:id — update. Salesmen may only edit their own lead, and
// may never change who it's assigned to; admins may edit anything,
// including reassigning the salesman.
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await getLeadOr404(req, res);
    if (!existing) return;
    if (!isAdmin(req) && existing.salesman_id !== req.session.user.id) {
      return res.status(403).json({ error: 'not_your_lead' });
    }

    const body = req.body || {};
    const errors = validateBody(body);
    if (errors.length) return res.status(400).json({ error: 'validation', details: errors });

    let salesmanId = existing.salesman_id;
    if (isAdmin(req) && body.salesman_id) {
      salesmanId = Number(body.salesman_id);
    }

    await pool.query(
      `UPDATE leads SET
        company=$1, contact=$2, phone=$3, email=$4, site=$5, county=$6, location=$7,
        service_type=$8, stage=$9, deal_value=$10, salesman_id=$11,
        last_contact=$12, next_follow_up=$13, notes=$14, updated_at=now()
       WHERE id=$15`,
      [
        body.company, body.contact || '', body.phone || '', body.email || '',
        body.site || '', body.county || '', body.location || '', body.service_type || '',
        body.stage || 'New Lead', Number(body.deal_value) || 0, salesmanId,
        body.last_contact || null, body.next_follow_up || null, body.notes || '',
        req.params.id,
      ]
    );
    const lead = await getLeadOr404(req, res);
    res.json({ lead });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/leads/:id — admin only.
router.delete('/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    await pool.query(`DELETE FROM leads WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
