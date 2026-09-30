const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function isAdmin(req) {
  return req.session.user.role === 'admin';
}

// Same match-or-create account lookup routes/leads.js uses. Kept as its
// own local copy (not shared/exported) so the two route files stay
// independent — duplicating ~10 lines here is cheaper than the coupling.
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

const SELECT_COLS = `
  a.id, a.assignment_code, a.account_id, a.account_name, a.target_date,
  a.contact_info, a.notes, a.salesman_id, su.name AS salesman_name,
  a.assigned_by, au.name AS assigned_by_name, a.status,
  a.response_text, a.responded_at, a.created_at, a.updated_at
`;
const FROM_JOIN = `
  FROM assignments a
  JOIN users su ON su.id = a.salesman_id
  JOIN users au ON au.id = a.assigned_by
`;

// GET /api/assignments?salesman_id=3 — admin sees every assignment
// (optionally filtered to one salesman, same pattern as Accounts/Leads);
// a salesman only ever sees their own, regardless of what's passed.
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = '1=1';
    if (!isAdmin(req)) {
      params.push(req.session.user.id);
      where += ` AND a.salesman_id = $${params.length}`;
    } else if (req.query.salesman_id) {
      params.push(Number(req.query.salesman_id));
      where += ` AND a.salesman_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE ${where} ORDER BY a.created_at DESC`,
      params
    );
    res.json({ assignments: result.rows });
  } catch (err) {
    next(err);
  }
});

async function getAssignmentOr404(req, res) {
  const result = await pool.query(`SELECT ${SELECT_COLS} ${FROM_JOIN} WHERE a.id = $1`, [req.params.id]);
  const a = result.rows[0];
  if (!a) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return a;
}

// GET /api/assignments/:id
router.get('/:id', async (req, res, next) => {
  try {
    const a = await getAssignmentOr404(req, res);
    if (!a) return;
    if (!isAdmin(req) && a.salesman_id !== req.session.user.id) {
      return res.status(403).json({ error: 'not_yours' });
    }
    res.json({ assignment: a });
  } catch (err) {
    next(err);
  }
});

function validateBody(body) {
  const errors = [];
  if (!body.account_name || !String(body.account_name).trim()) errors.push('Target account name is required.');
  if (!body.salesman_id) errors.push('Select a salesman to assign this to.');
  return errors;
}

// POST /api/assignments — admin only. Resolves/creates the target account
// (same match-or-create as a lead's account name) and drops a notification
// for the salesman it's assigned to.
router.post('/', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    const body = req.body || {};
    const errors = validateBody(body);
    if (errors.length) return res.status(400).json({ error: 'validation', details: errors });

    const account = await resolveAccount(body.account_name);
    if (!account) return res.status(400).json({ error: 'validation', details: ['Target account name is required.'] });

    const salesman = await pool.query(
      `SELECT id, name FROM users WHERE id = $1 AND role = 'salesman'`,
      [Number(body.salesman_id)]
    );
    if (!salesman.rows[0]) return res.status(400).json({ error: 'validation', details: ['Pick a valid salesman.'] });

    const codeResult = await pool.query(`SELECT nextval('assignment_code_seq') AS n`);
    const assignmentCode = 'AS-' + String(codeResult.rows[0].n).padStart(4, '0');

    const inserted = await pool.query(
      `INSERT INTO assignments
        (assignment_code, account_id, account_name, target_date, contact_info, notes, salesman_id, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        assignmentCode, account.id, account.name,
        body.target_date || null, body.contact_info || '', body.notes || '',
        salesman.rows[0].id, req.session.user.id,
      ]
    );
    const id = inserted.rows[0].id;

    const dateNote = body.target_date ? ' (target date ' + body.target_date + ')' : '';
    await pool.query(
      `INSERT INTO notifications (user_id, type, assignment_id, message) VALUES ($1,'assignment_new',$2,$3)`,
      [salesman.rows[0].id, id, 'New target account assigned: ' + account.name + dateNote]
    );

    req.params.id = id;
    const a = await getAssignmentOr404(req, res);
    res.status(201).json({ assignment: a });
  } catch (err) {
    next(err);
  }
});

// PUT /api/assignments/:id — admin only. Edit the target account, date,
// contact info, notes, or reassign to a different salesman. Reassigning
// sends a fresh "new assignment" notification to the newly-picked salesman
// (the previous one just loses access to it, no notification needed).
router.put('/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    const existing = await getAssignmentOr404(req, res);
    if (!existing) return;

    const body = req.body || {};
    const errors = validateBody(body);
    if (errors.length) return res.status(400).json({ error: 'validation', details: errors });

    const account = await resolveAccount(body.account_name);
    if (!account) return res.status(400).json({ error: 'validation', details: ['Target account name is required.'] });

    const salesman = await pool.query(
      `SELECT id, name FROM users WHERE id = $1 AND role = 'salesman'`,
      [Number(body.salesman_id)]
    );
    if (!salesman.rows[0]) return res.status(400).json({ error: 'validation', details: ['Pick a valid salesman.'] });

    const reassigned = Number(existing.salesman_id) !== Number(salesman.rows[0].id);

    await pool.query(
      `UPDATE assignments SET
        account_id=$1, account_name=$2, target_date=$3, contact_info=$4, notes=$5,
        salesman_id=$6, updated_at=now()
       WHERE id=$7`,
      [account.id, account.name, body.target_date || null, body.contact_info || '', body.notes || '', salesman.rows[0].id, req.params.id]
    );

    if (reassigned) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, assignment_id, message) VALUES ($1,'assignment_new',$2,$3)`,
        [salesman.rows[0].id, req.params.id, 'Target account assigned to you: ' + account.name]
      );
    }

    const a = await getAssignmentOr404(req, res);
    res.json({ assignment: a });
  } catch (err) {
    next(err);
  }
});

// POST /api/assignments/:id/respond — the assigned salesman (or an admin,
// covering for them) writes or updates a reply. Always notifies the admin
// who made the assignment, even on an update — a changed answer is worth
// flagging again.
router.post('/:id/respond', async (req, res, next) => {
  try {
    const existing = await getAssignmentOr404(req, res);
    if (!existing) return;
    if (!isAdmin(req) && existing.salesman_id !== req.session.user.id) {
      return res.status(403).json({ error: 'not_yours' });
    }
    const responseText = String((req.body || {}).response_text || '').trim();
    if (!responseText) return res.status(400).json({ error: 'validation', details: ['Enter a response before sending.'] });

    await pool.query(
      `UPDATE assignments SET response_text=$1, status='responded', responded_at=now(), updated_at=now() WHERE id=$2`,
      [responseText, req.params.id]
    );

    await pool.query(
      `INSERT INTO notifications (user_id, type, assignment_id, message) VALUES ($1,'assignment_response',$2,$3)`,
      [existing.assigned_by, req.params.id, req.session.user.name + ' responded on ' + existing.account_name]
    );

    const a = await getAssignmentOr404(req, res);
    res.json({ assignment: a });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/assignments/:id — admin only.
router.delete('/:id', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin_required' });
    await pool.query(`DELETE FROM assignments WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
