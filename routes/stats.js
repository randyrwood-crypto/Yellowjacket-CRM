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

router.get('/', async (req, res, next) => {
  try {
    const params = [currentPeriod()];
    let scope = '';
    if (!isAdmin(req)) {
      params.push(req.session.user.id);
      scope = ` AND salesman_id = $2`;
    }

    const byStage = await pool.query(
      `SELECT stage, count(*)::int AS n, coalesce(sum(deal_value),0)::numeric AS value
       FROM leads WHERE period = $1${scope} GROUP BY stage`,
      params
    );
    const totals = await pool.query(
      `SELECT count(*)::int AS lead_count, coalesce(sum(deal_value),0)::numeric AS pipeline_value
       FROM leads WHERE period = $1${scope}`,
      params
    );
    const overdue = await pool.query(
      `SELECT count(*)::int AS n FROM leads
       WHERE period = $1${scope} AND next_follow_up IS NOT NULL AND next_follow_up < CURRENT_DATE
         AND stage NOT IN ('Won','Lost')`,
      params
    );

    let bySalesman = [];
    if (isAdmin(req)) {
      const bySalesmanResult = await pool.query(
        `SELECT users.name, count(leads.*)::int AS n, coalesce(sum(leads.deal_value),0)::numeric AS value
         FROM users LEFT JOIN leads ON leads.salesman_id = users.id AND leads.period = $1
         WHERE users.role = 'salesman'
         GROUP BY users.name ORDER BY value DESC`,
        [currentPeriod()]
      );
      bySalesman = bySalesmanResult.rows;
    }

    res.json({
      currentPeriod: currentPeriod(),
      totals: totals.rows[0],
      overdueCount: overdue.rows[0].n,
      byStage: byStage.rows,
      bySalesman,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
