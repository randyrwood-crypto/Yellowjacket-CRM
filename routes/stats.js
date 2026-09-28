const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const STAGE_ORDER = ['New Lead', 'Contacted', 'Quoted', 'Negotiating', 'Won', 'Lost'];

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

    // Every stage EXCEPT Won is still driven by deal_value on the lead
    // itself. Won is driven by lead_wins instead, so partial wins logged
    // against a lead that's still sitting in another stage (e.g.
    // Negotiating) still count toward this month's Won total.
    const byStage = await pool.query(
      `SELECT stage, count(*)::int AS n, coalesce(sum(deal_value),0)::numeric AS value
       FROM leads WHERE period = $1${scope} AND stage <> 'Won' GROUP BY stage`,
      params
    );
    const won = await pool.query(
      `SELECT count(DISTINCT lead_id)::int AS n, coalesce(sum(amount),0)::numeric AS value
       FROM lead_wins WHERE period = $1${scope}`,
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

    let stageRows = byStage.rows;
    if (won.rows[0].n > 0) {
      stageRows = stageRows.concat([{ stage: 'Won', n: won.rows[0].n, value: won.rows[0].value }]);
    }
    stageRows.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));

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
      byStage: stageRows,
      wonTotal: won.rows[0].value,
      bySalesman,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
