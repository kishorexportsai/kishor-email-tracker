// backend/server.js
// Main server — API routes, cron jobs, dashboard serving

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { runOutlookFetcher } = require('./outlookFetcher');
const { runGmailFetcher } = require('./gmailFetcher');
const { sendDailyAgentReminders, sendDailyManagerReminders, sendWeeklyReports } = require('./reminderSender');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── AUTH MIDDLEWARE ───
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── AUTH ROUTES ───
// One-time setup route to create admin user
app.get('/api/create-admin', async (req, res) => {
  const hash = await bcrypt.hash('Kishor@123', 10);
  await supabase.from('users').delete().eq('email', 'admin@kishorexports.com');
  await supabase.from('users').insert({
    name: 'Admin',
    email: 'admin@kishorexports.com',
    password_hash: hash,
    role: 'senior_manager',
    account_email: 'hi@kishorexports.com',
    is_active: true
  });
  res.json({ message: 'Admin created!', password: 'Kishor@123' });
});
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .eq('is_active', true)
    .single();

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name, account_email: user.account_email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// ─── DASHBOARD STATS ───
app.get('/api/stats', authMiddleware, async (req, res) => {
  const { role, account_email, email } = req.user;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let accountFilter = [];

  if (role === 'agent') {
    accountFilter = [account_email];
  } else if (role === 'manager') {
    const { data: agents } = await supabase
      .from('users').select('account_email').eq('manager_email', email);
    accountFilter = (agents || []).map(a => a.account_email).filter(Boolean);
  } else {
    // senior_manager — all accounts
    const { data: allUsers } = await supabase
      .from('users').select('account_email').eq('role', 'agent');
    accountFilter = (allUsers || []).map(a => a.account_email).filter(Boolean);
  }

  if (accountFilter.length === 0) return res.json({ total: 0, replied: 0, unreplied: 0, today: 0 });

  const [total, replied, unreplied, todayEmails] = await Promise.all([
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter),
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter).eq('status', 'replied'),
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter).eq('status', 'unreplied'),
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter).gte('received_at', today.toISOString())
  ]);

  res.json({
    total: total.count || 0,
    replied: replied.count || 0,
    unreplied: unreplied.count || 0,
    today: todayEmails.count || 0
  });
});

// ─── GET UNREPLIED EMAILS ───
app.get('/api/emails/unreplied', authMiddleware, async (req, res) => {
  const { role, account_email, email } = req.user;
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let accountFilter = [];

  if (role === 'agent') {
    accountFilter = [account_email];
  } else if (role === 'manager') {
    const { data: agents } = await supabase
      .from('users').select('account_email').eq('manager_email', email);
    accountFilter = (agents || []).map(a => a.account_email).filter(Boolean);
  } else {
    const { data: allUsers } = await supabase
      .from('users').select('account_email').eq('role', 'agent');
    accountFilter = (allUsers || []).map(a => a.account_email).filter(Boolean);
  }

  const { data, error, count } = await supabase
    .from('emails')
    .select('*', { count: 'exact' })
    .in('account', accountFilter)
    .eq('status', 'unreplied')
    .order('received_at', { ascending: false })
    .range(offset, offset + limit - 1);

  res.json({ emails: data || [], total: count || 0 });
});

// ─── GET ALL EMAILS ───
app.get('/api/emails', authMiddleware, async (req, res) => {
  const { role, account_email, email } = req.user;
  const { page = 1, limit = 20, status, account } = req.query;
  const offset = (page - 1) * limit;

  let accountFilter = [];
  if (role === 'agent') {
    accountFilter = [account_email];
  } else if (role === 'manager') {
    const { data: agents } = await supabase
      .from('users').select('account_email').eq('manager_email', email);
    accountFilter = (agents || []).map(a => a.account_email).filter(Boolean);
  } else {
    const { data: allUsers } = await supabase
      .from('users').select('account_email').eq('role', 'agent');
    accountFilter = (allUsers || []).map(a => a.account_email).filter(Boolean);
  }

  if (account && accountFilter.includes(account)) accountFilter = [account];

  let query = supabase.from('emails').select('*', { count: 'exact' })
    .in('account', accountFilter)
    .order('received_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  res.json({ emails: data || [], total: count || 0 });
});

// ─── GET AGENTS LIST (for manager/senior_manager) ───
app.get('/api/agents', authMiddleware, async (req, res) => {
  const { role, email } = req.user;
  if (role === 'agent') return res.json([]);

  let query = supabase.from('users').select('id,name,email,account_email,role').eq('role', 'agent');
  if (role === 'manager') query = query.eq('manager_email', email);

  const { data } = await query;
  res.json(data || []);
});

// ─── WEEKLY REPORT PER AGENT ───
app.get('/api/report/weekly/:agentEmail', authMiddleware, async (req, res) => {
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);

  const { data: allEmails } = await supabase.from('emails').select('*')
    .eq('account', req.params.agentEmail)
    .gte('received_at', weekStart.toISOString());

  const { data: unreplied } = await supabase.from('emails').select('*')
    .eq('account', req.params.agentEmail)
    .eq('status', 'unreplied')
    .gte('received_at', weekStart.toISOString());

  res.json({
    total: allEmails?.length || 0,
    replied: (allEmails?.length || 0) - (unreplied?.length || 0),
    unreplied: unreplied?.length || 0,
    unrepliedEmails: unreplied || []
  });
});

// ─── MANUAL TRIGGER (for testing) ───
app.post('/api/trigger/fetch', authMiddleware, async (req, res) => {
  if (req.user.role !== 'senior_manager') return res.status(403).json({ error: 'Not allowed' });
  runOutlookFetcher().catch(console.error);
  runGmailFetcher().catch(console.error);
  res.json({ message: 'Fetch triggered' });
});

// ─── SERVE FRONTEND ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── CRON JOBS ───

// Every 5 minutes — fetch emails and check replies
cron.schedule('*/5 * * * *', async () => {
  console.log('[Cron] Running email fetch...');
  try {
    await runOutlookFetcher();
    await runGmailFetcher();
  } catch (err) {
    console.error('[Cron] Fetch error:', err.message);
  }
});

// Every day at 9:00 AM IST (3:30 UTC)
cron.schedule('30 3 * * *', async () => {
  console.log('[Cron] Sending daily reminders...');
  try {
    await sendDailyAgentReminders();
    await sendDailyManagerReminders();
  } catch (err) {
    console.error('[Cron] Daily reminder error:', err.message);
  }
});

// Every Saturday at 10:00 AM IST (4:30 UTC)
cron.schedule('30 4 * * 6', async () => {
  console.log('[Cron] Sending weekly reports...');
  try {
    await sendWeeklyReports();
  } catch (err) {
    console.error('[Cron] Weekly report error:', err.message);
  }
});

// ─── START SERVER ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Kishor Email Tracker running on port ${PORT}`);
  console.log(`📧 Outlook accounts: ${process.env.OUTLOOK_ACCOUNTS}`);
  console.log(`📧 Gmail accounts: ${process.env.GMAIL_ACCOUNTS}`);
  // Run initial fetch on startup
  setTimeout(() => {
    runOutlookFetcher().catch(console.error);
    runGmailFetcher().catch(console.error);
  }, 5000);
});
