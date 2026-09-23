function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin_required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
