const express = require('express');
const PDFDocument = require('pdfkit');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const STAGES = ['New Lead', 'Contacted', 'Quoted', 'Negotiating', 'Won', 'Lost'];

function currentPeriod() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function isAdmin(req) {
  return req.session.user.role === 'admin';
}

function monthLabelServer(period) {
  if (!period || period === 'all') return 'All periods';
  const parts = period.split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Finds an account by exact (case-insensitive) name, or creates one. Used
// by both create and edit, so a lead can be attached to an existing
// account by typing its name, or spin up a brand-new account on the spot.
// Race-safe: two people creating "Acme" at the same instant both land on
// the same account row, via the UNIQUE(name) constraint + ON CONFLICT.
async function resolveAccount(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const existing = await pool.query(`SELECT id, name FROM accounts WHERE lower(name) = lower($1)`, [trimmed]);
  if (existing.rows[0]) return existing.rows[0];
  const inserted = await pool.query(
    `INSERT INTO accounts (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id, name`,
    [trimmed]
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const retry = await pool.query(`SELECT id, name FROM accounts WHERE lower(name) = lower($1)`, [trimmed]);
  return retry.rows[0] || null;
}

// Row shape sent to the client. company is read through the joined account
// (the account is the shared record a company's leads are grouped under —
// see db/schema.sql), but contact/phone/email are the LEAD's own columns:
// the same company can have several different people across different
// leads/opportunities, so each lead keeps its own contact rather than
// inheriting the account's. The account also has its own contact/phone/
// email (see routes/accounts.js) used as that company's primary contact on
// the Accounts page.
// won_to_date is the running sum of everything logged in lead_wins for
// this lead so far (any period), independent of the lead's current stage.
const SELECT_COLS = `
  leads.id, leads.lead_code, leads.account_id,
  accounts.name AS company, leads.contact, leads.phone, leads.email,
  leads.site, leads.county, leads.location, leads.service_type, leads.stage,
  leads.deal_value, leads.salesman_id, users.name AS salesman_name,
  leads.last_contact, leads.next_follow_up, leads.notes, leads.period,
  leads.created_at, leads.updated_at,
  COALESCE((SELECT sum(amount) FROM lead_wins WHERE lead_wins.lead_id = leads.id), 0) AS won_to_date
`;
const FROM_JOIN = `
  FROM leads
  JOIN users ON users.id = leads.salesman_id
  LEFT JOIN accounts ON accounts.id = leads.account_id
`;

// Builds the shared WHERE clause for the list + PDF-export endpoints:
// period (defaults to current, "all" for every period) and, for admins
// only, an optional salesman_id filter — salesmen always stay scoped to
// their own records regardless of what's passed.
function buildListFilter(req) {
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
  } else if (req.query.salesman_id) {
    params.push(Number(req.query.salesman_id));
    where += ` AND leads.salesman_id = $${params.length}`;
  }
  return { period, params, where };
}

// GET /api/leads?period=2026-09&salesman_id=3
// period defaults to the current period ("all" for every period); salesman_id
// is admin-only — an admin picking a salesman from the Leads page filter.
router.get('/', async (req, res, next) => {
  try {
    const { period, params, where } = buildListFilter(req);
    const result = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE ${where} ORDER BY leads.created_at DESC`,
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

// GET /api/leads/export/pdf — admin-only, high-level printable PDF of the
// leads currently in view (same period/salesman filter as the Leads page).
router.get('/export/pdf', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    const { period, params, where } = buildListFilter(req);
    const result = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE ${where} ORDER BY accounts.name ASC`,
      params
    );
    const leads = result.rows;

    const doc = new PDFDocument({ margin: 36, size: 'letter', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="yjcrm-leads-${period}.pdf"`);
    doc.pipe(res);

    const cols = [
      { key: 'lead_code', label: 'Lead ID', width: 55 },
      { key: 'company', label: 'Account', width: 170 },
      { key: 'stage', label: 'Stage', width: 85 },
      { key: 'deal_value', label: 'Deal Value', width: 85 },
      { key: 'salesman_name', label: 'Salesman', width: 110 },
      { key: 'next_follow_up', label: 'Next Follow-Up', width: 95 },
      { key: 'won_to_date', label: 'Won to Date', width: 85 },
    ];
    const startX = doc.page.margins.left;
    const tableWidth = cols.reduce((a, c) => a + c.width, 0);
    const ROW_H = 16;

    function drawHeader() {
      const rowY = doc.y;
      let x = startX;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
      cols.forEach((c) => {
        doc.text(c.label, x, rowY, { width: c.width - 6, height: 12, ellipsis: true, lineBreak: false });
        x += c.width;
      });
      doc.y = rowY + 14;
      doc.moveTo(startX, doc.y).lineTo(startX + tableWidth, doc.y).strokeColor('#ccc').stroke();
      doc.y += 6;
      doc.font('Helvetica').fillColor('#222');
    }

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#000').text('Yellowjacket Sales CRM');
    doc.font('Helvetica').fontSize(11).fillColor('#555').text(
      'Leads & Accounts — ' + monthLabelServer(period) +
      (req.query.salesman_id ? ' · Filtered by salesman' : '') +
      ' · Generated ' + new Date().toLocaleDateString('en-US')
    );
    doc.moveDown(1);
    doc.fillColor('#000');
    drawHeader();

    let totalDealValue = 0;
    let totalWon = 0;
    leads.forEach((l) => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
        doc.addPage();
        drawHeader();
      }
      const rowY = doc.y;
      let x = startX;
      const cells = [
        l.lead_code,
        l.company || '',
        l.stage || '',
        '$' + Number(l.deal_value || 0).toLocaleString('en-US'),
        l.salesman_name || '',
        l.next_follow_up ? String(l.next_follow_up).slice(0, 10) : '—',
        '$' + Number(l.won_to_date || 0).toLocaleString('en-US'),
      ];
      cols.forEach((c, i) => {
        doc.fontSize(9).text(String(cells[i]), x, rowY, { width: c.width - 6, height: 12, ellipsis: true, lineBreak: false });
        x += c.width;
      });
      doc.y = rowY + ROW_H;
      totalDealValue += Number(l.deal_value || 0);
      totalWon += Number(l.won_to_date || 0);
    });

    doc.moveDown(0.5);
    doc.moveTo(startX, doc.y).lineTo(startX + tableWidth, doc.y).strokeColor('#ccc').stroke();
    doc.y += 8;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(
      leads.length + ' lead(s) · Total Deal Value: $' + totalDealValue.toLocaleString('en-US') +
      ' · Total Won: $' + totalWon.toLocaleString('en-US'),
      startX, doc.y, { width: tableWidth }
    );

    doc.end();
  } catch (err) {
    next(err);
  }
});

async function getLeadOr404(req, res) {
  const result = await pool.query(
    `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE leads.id = $1`,
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

// GET /api/leads/:id/wins — the full history of partial/full win amounts
// logged against this lead, most recent first.
router.get('/:id/wins', async (req, res, next) => {
  try {
    const lead = await getLeadOr404(req, res);
    if (!lead) return;
    if (!isAdmin(req) && lead.salesman_id !== req.session.user.id) {
      return res.status(403).json({ error: 'not_your_lead' });
    }
    const result = await pool.query(
      `SELECT id, lead_id, amount, note, salesman_id, period, created_at
       FROM lead_wins WHERE lead_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ wins: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/wins — log a win amount (can be the full deal value
// or just part of it). Does NOT change the lead's stage — a deal can stay
// "Negotiating" while partial wins are logged against it over time. Always
// credited to whichever salesman owns the lead, and to the CURRENT period,
// so it shows up on this month's dashboard regardless of when the lead was
// first created.
router.post('/:id/wins', async (req, res, next) => {
  try {
    const lead = await getLeadOr404(req, res);
    if (!lead) return;
    if (!isAdmin(req) && lead.salesman_id !== req.session.user.id) {
      return res.status(403).json({ error: 'not_your_lead' });
    }
    const amount = Number((req.body || {}).amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'validation', details: ['Enter an amount greater than 0.'] });
    }
    const note = (req.body || {}).note || '';
    const result = await pool.query(
      `INSERT INTO lead_wins (lead_id, amount, note, salesman_id, period)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, lead_id, amount, note, salesman_id, period, created_at`,
      [req.params.id, amount, note, lead.salesman_id, currentPeriod()]
    );
    res.status(201).json({ win: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/leads/:id/wins/:winId — admin only, to correct a mistaken entry.
router.delete('/:id/wins/:winId', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    await pool.query(`DELETE FROM lead_wins WHERE id = $1 AND lead_id = $2`, [req.params.winId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function validateBody(body) {
  const errors = [];
  if (!body.account_name || !String(body.account_name).trim()) errors.push('Account name is required.');
  if (body.stage && !STAGES.includes(body.stage)) errors.push('Invalid stage.');
  return errors;
}

// POST /api/leads — create. Salesmen are always tagged with their own id,
// regardless of what (if anything) is sent for salesman_id — enforced here,
// not just hidden in the UI. account_name matches an existing account
// (case-insensitively) or creates a new one on the spot. last_contact is
// always stamped to today: the moment a lead is touched (created or,
// below, edited) IS the contact. `company` is still written too, only as
// the historical snapshot column described in db/schema.sql — the app
// never reads it back. contact/phone/email belong to THIS lead (this
// opportunity's point of contact at the account), not the account itself.
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const errors = validateBody(body);
    if (errors.length) return res.status(400).json({ error: 'validation', details: errors });

    const account = await resolveAccount(body.account_name);
    if (!account) return res.status(400).json({ error: 'validation', details: ['Account name is required.'] });

    let salesmanId = req.session.user.id;
    if (isAdmin(req) && body.salesman_id) {
      salesmanId = Number(body.salesman_id);
    }

    const codeResult = await pool.query(`SELECT nextval('lead_code_seq') AS n`);
    const leadCode = 'YJ-' + String(codeResult.rows[0].n).padStart(4, '0');

    const result = await pool.query(
      `INSERT INTO leads
        (lead_code, company, account_id, contact, phone, email, site, county, location,
         service_type, stage, deal_value, salesman_id, last_contact, next_follow_up,
         notes, period)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        leadCode, account.name, account.id,
        body.contact || '', body.phone || '', body.email || '',
        body.site || '', body.county || '', body.location || '', body.service_type || '',
        body.stage || 'New Lead', Number(body.deal_value) || 0, salesmanId,
        todayISODate(), body.next_follow_up || null, body.notes || '',
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
// including reassigning the salesman. account_name can move the lead to a
// different (or brand-new) account, same matching rules as create. Every
// save re-stamps last_contact to today, same as creating one — touching
// the lead at all counts as contact.
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

    const account = await resolveAccount(body.account_name);
    if (!account) return res.status(400).json({ error: 'validation', details: ['Account name is required.'] });

    let salesmanId = existing.salesman_id;
    if (isAdmin(req) && body.salesman_id) {
      salesmanId = Number(body.salesman_id);
    }

    await pool.query(
      `UPDATE leads SET
        company=$1, account_id=$2, contact=$3, phone=$4, email=$5, site=$6, county=$7, location=$8,
        service_type=$9, stage=$10, deal_value=$11, salesman_id=$12,
        last_contact=$13, next_follow_up=$14, notes=$15, updated_at=now()
       WHERE id=$16`,
      [
        account.name, account.id, body.contact || '', body.phone || '', body.email || '',
        body.site || '', body.county || '', body.location || '', body.service_type || '',
        body.stage || 'New Lead', Number(body.deal_value) || 0, salesmanId,
        todayISODate(), body.next_follow_up || null, body.notes || '',
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
