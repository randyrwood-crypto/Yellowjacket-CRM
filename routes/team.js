const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAdmin, requireAuth } = require('../middleware/auth');

const router = express.Router();

// Any signed-in user can see the roster (needed to populate the "Salesman"
// dropdown when an admin adds/reassigns a lead) — but only admins can
// add, remove, or reset a password.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, role, created_at FROM users ORDER BY role DESC, name ASC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

router.use(requireAdmin);

router.post('/', async (req, res, next) => {
  try {
    const { name, password, role } = req.body || {};
    if (!name || !password) {
      return res.status(400).json({ error: 'validation', details: ['Name and password are required.'] });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'validation', details: ['Password must be at least 8 characters.'] });
    }
    const finalRole = role === 'admin' ? 'admin' : 'salesman';
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (name, password_hash, role) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING RETURNING id, name, role, created_at`,
      [name, hash, finalRole]
    );
    if (!result.rows[0]) {
      return res.status(409).json({ error: 'name_taken' });
    }
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/password', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'validation', details: ['Password must be at least 8 characters.'] });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, name, role`,
      [hash, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Removing a user leaves their historical leads/lost-opportunities in
// place (salesman_id has no ON DELETE CASCADE) so past records aren't
// silently destroyed — block the delete instead, and tell the admin why.
router.delete('/:id', async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.session.user.id) {
      return res.status(400).json({ error: 'cannot_remove_self' });
    }
    const leadCount = await pool.query(`SELECT count(*) FROM leads WHERE salesman_id = $1`, [req.params.id]);
    const lostCount = await pool.query(`SELECT count(*) FROM lost_opportunities WHERE salesman_id = $1`, [req.params.id]);
    if (Number(leadCount.rows[0].count) > 0 || Number(lostCount.rows[0].count) > 0) {
      return res.status(409).json({
        error: 'has_records',
        message: 'This person has leads or lost-opportunity records on file. Reassign or archive those first, or just reset their password instead of removing them.',
      });
    }
    const result = await pool.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
