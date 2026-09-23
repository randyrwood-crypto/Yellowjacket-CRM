require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const leadsRoutes = require('./routes/leads');
const lostOppRoutes = require('./routes/lostOpportunities');
const teamRoutes = require('./routes/team');
const statsRoutes = require('./routes/stats');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // Render sits behind a proxy/load balancer

app.use(
  helmet({
    // The frontend has no inline <script> tags (all JS lives in /app.js),
    // so scriptSrc stays locked to 'self'. It does set inline style="..."
    // attributes for data-driven colors/widths (stage colors, bar chart
    // fills) — allowing 'unsafe-inline' for styles only is the standard,
    // low-risk tradeoff (CSS injection is a much smaller blast radius than
    // script injection, which stays fully blocked).
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);
app.use(express.json({ limit: '1mb' }));

app.use(
  session({
    store: new pgSession({ pool, tableName: 'session' }),
    name: 'yjcrm.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    },
  })
);

// Modest rate limiting on login to slow down password guessing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', loginLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/lost-opportunities', lostOppRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/stats', statsRoutes);

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized error handler — never leak stack traces to the client.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set. Refusing to start — see .env.example.');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`Yellowjacket Sales CRM listening on port ${PORT}`);
});

module.exports = app;
