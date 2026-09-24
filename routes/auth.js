const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// List of salesman names for the login dropdown — no passwords, admin
// accounts excluded so the login form can't be used to fish for who's admin.
router.get('/roster', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT name FROM users WHERE role = 'salesman' ORDER BY name ASC`
    );
    res.json({ salesmen: result.rows.map((r) => r.name) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { name, password } = req.body || {};
    if (!name || !password) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const result = await pool.query(`SELECT * FROM users WHERE name = $1`, [name]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: user.id, name: user.name, role: user.role };
      req.session.save((err2) => {
        if (err2) return next(err2);
        res.json({ user: req.session.user });
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('yjcrm.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  res.json({ user: (req.session && req.session.user) || null });
});

// PUT /api/auth/password — self-service password change for whoever is
// signed in (salesman or admin). Requires the current password, unlike the
// admin-only Team-page reset, which doesn't (that's for when someone is
// locked out and needs an admin to set a fresh one for them).
router.put('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'validation', details: ['Current and new password are required.'] });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'validation', details: ['New password must be at least 8 characters.'] });
    }
    const result = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.session.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'not_found' });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'wrong_password', details: ['Current password is incorrect.'] });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.session.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
