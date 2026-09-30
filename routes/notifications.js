const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications/count — cheap, non-destructive. Polled by the
// bell badge in the rail so the unread count stays current without the
// user having to open the panel.
router.get('/count', async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [req.session.user.id]);
    res.json({ count: result.rows[0].n });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications — fetches AND deletes this user's notifications
// in one step. Opening the bell dropdown is what "views" them, so there's
// deliberately no separate read/unread flag to manage: once this endpoint
// returns a notification, it's gone for good — see db/schema.sql.
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `WITH deleted AS (
         DELETE FROM notifications WHERE user_id = $1
         RETURNING id, type, assignment_id, message, created_at
       )
       SELECT * FROM deleted ORDER BY created_at DESC`,
      [req.session.user.id]
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
