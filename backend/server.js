// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { runGmailFetcher, saveTokenToSupabase } = require('./gmailFetcher');
const { sendDailyAgentReminders, sendDailyManagerReminders, sendWeeklyReports } = require('./reminderSender');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name, account_email: user.account_email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ─── CREATE ADMIN ────────────────────────────────────────────────
app.get('/api/create-admin', async (req, res) => {
  const hash = await bcrypt.hash('Kishor@123', 10);
  await supabase.from('users').delete().eq('email', 'admin@kishorexports.com');
  await supabase.from('users').insert({
    name: 'Admin', email: 'admin@kishorexports.com', password_hash: hash,
    role: 'senior_manager', account_email: 'hi@kishorexports.com', is_active: true
  });
  res.json({ message: 'Admin created!', password: 'Kishor@123' });
});

// ─── EMAIL/PASSWORD LOGIN ────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).eq('is_active', true).single();
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: makeToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// ─── GOOGLE SIGN-IN ──────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.metadata',
      'email', 'profile'
    ],
    state: 'google_signin'
  });
  res.redirect(url);
});

// ─── GMAIL CALLBACK ──────────────────────────────────────────────
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send('<h2>Error: No code received</h2>');

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: googleUser } = await oauth2.userinfo.get();
    const gmailAddress = googleUser.email;
    const googleName = googleUser.name;

    let dbUser;

    if (state === 'google_signin') {
      const { data: existing } = await supabase.from('users')
        .select('*').eq('account_email', gmailAddress).single();

      if (existing) {
        dbUser = existing;
        await saveTokenToSupabase(gmailAddress, tokens);
      } else {
        const { data: created } = await supabase.from('users').insert({
          name: googleName, email: gmailAddress, password_hash: '',
          role: 'agent', account_email: gmailAddress, is_active: true,
          gmail_token: JSON.stringify(tokens)
        }).select().single();
        dbUser = created;
      }

      if (!dbUser) return res.send('<h2>Error creating user</h2>');

      const jwtToken = makeToken(dbUser);
      setTimeout(() => runGmailFetcher().catch(console.error), 2000);

      return res.send(`<!DOCTYPE html><html><head><title>Signing in...</title></head><body style="font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8;">
        <div style="text-align:center;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
          <div style="font-size:60px;">✅</div>
          <h2 style="color:#1E3A5F;margin:16px 0 8px;">Signed in as ${googleName}!</h2>
          <p style="color:#666;">${gmailAddress}</p>
          <p style="color:#888;font-size:13px;margin-top:8px;">Redirecting to dashboard...</p>
        </div>
        <script>
          localStorage.setItem('ke_token', '${jwtToken}');
          localStorage.setItem('ke_user', JSON.stringify(${JSON.stringify({ id: dbUser.id, name: dbUser.name, email: dbUser.email, role: dbUser.role })}));
          setTimeout(() => window.location.href = '/', 1500);
        </script>
      </body></html>`);

    } else {
      if (state) {
        await saveTokenToSupabase(gmailAddress, tokens);
        await supabase.from('users').update({ account_email: gmailAddress }).eq('email', state);
      }
      setTimeout(() => runGmailFetcher().catch(console.error), 2000);

      return res.send(`<!DOCTYPE html><html><body style="font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8;">
        <div style="text-align:center;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
          <div style="font-size:60px;">✅</div>
          <h2 style="color:#1E3A5F;margin:16px 0 8px;">Gmail Connected!</h2>
          <p style="color:#666;">${gmailAddress} is now connected.</p>
          <p style="color:#888;font-size:13px;margin-top:8px;">Emails will sync every 5 minutes automatically.</p>
          <a href="/" style="display:inline-block;margin-top:24px;padding:12px 28px;background:#1E3A5F;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Go to Dashboard →</a>
        </div>
      </body></html>`);
    }

  } catch (err) {
    console.error('OAuth callback error:', err);
    res.send(`<h2>Error: ${err.message}</h2>`);
  }
});

// ─── CONNECT GMAIL ───────────────────────────────────────────────
app.get('/auth/gmail', (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.redirect('/?error=auth'); }
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.metadata',
      'email', 'profile'
    ],
    state: user.email
  });
  res.redirect(url);
});

// ─── GMAIL STATUS ────────────────────────────────────────────────
app.get('/api/gmail/status', authMiddleware, async (req, res) => {
  const { data: user } = await supabase.from('users')
    .select('account_email, gmail_token').eq('id', req.user.id).single();
  const account = user?.account_email || req.user.account_email;
  if (!account) return res.json({ connected: false });
  const connected = !!(user?.gmail_token);
  res.json({ connected, account });
});

// ─── ACCOUNT FILTER HELPER ───────────────────────────────────────
async function getAccountFilter(role, account_email, email) {
  if (role === 'agent') return [account_email].filter(Boolean);
  if (role === 'manager') {
    const { data } = await supabase.from('users').select('account_email').eq('manager_email', email);
    const accounts = (data || []).map(a => a.account_email).filter(Boolean);
    if (account_email) accounts.push(account_email);
    return [...new Set(accounts)];
  }
  const { data } = await supabase.from('users').select('account_email').eq('is_active', true);
  return [...new Set((data || []).map(a => a.account_email).filter(Boolean))];
}

// ─── STATS (with repliedToday) ───────────────────────────────────
app.get('/api/stats', authMiddleware, async (req, res) => {
  const { role, account_email, email } = req.user;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const accountFilter = await getAccountFilter(role, account_email, email);
  if (!accountFilter.length) return res.json({ total: 0, replied: 0, unreplied: 0, today: 0, repliedToday: 0 });

  const [t, r, u, d, rd] = await Promise.all([
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter),
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter).eq('status', 'replied'),
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter).eq('status', 'unreplied'),
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter).gte('received_at', today.toISOString()),
    supabase.from('emails').select('id', { count: 'exact' }).in('account', accountFilter).eq('status', 'replied').gte('replied_at', today.toISOString())
  ]);

  res.json({
    total: t.count || 0,
    replied: r.count || 0,
    unreplied: u.count || 0,
    today: d.count || 0,
    repliedToday: rd.count || 0
  });
});

// ─── EMAILS ──────────────────────────────────────────────────────
app.get('/api/emails/unreplied', authMiddleware, async (req, res) => {
  const { role, account_email, email } = req.user;
  const { page = 1, limit = 20 } = req.query;
  const accountFilter = await getAccountFilter(role, account_email, email);
  if (!accountFilter.length) return res.json({ emails: [], total: 0 });
  const { data, count } = await supabase.from('emails').select('*', { count: 'exact' })
    .in('account', accountFilter).eq('status', 'unreplied')
    .order('received_at', { ascending: false }).range((page-1)*limit, page*limit-1);
  res.json({ emails: data || [], total: count || 0 });
});

app.get('/api/emails', authMiddleware, async (req, res) => {
  const { role, account_email, email } = req.user;
  const { page = 1, limit = 20, status } = req.query;
  const accountFilter = await getAccountFilter(role, account_email, email);
  if (!accountFilter.length) return res.json({ emails: [], total: 0 });
  let query = supabase.from('emails').select('*', { count: 'exact' }).in('account', accountFilter)
    .order('received_at', { ascending: false }).range((page-1)*limit, page*limit-1);
  if (status) query = query.eq('status', status);
  const { data, count } = await query;
  res.json({ emails: data || [], total: count || 0 });
});

// ─── UPDATE EMAIL STATUS ─────────────────────────────────────────
app.patch('/api/emails/:id/status', authMiddleware, async (req, res) => {
  const { status } = req.body;
  await supabase.from('emails').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ success: true });
});

// ─── AGENTS ──────────────────────────────────────────────────────
app.get('/api/agents', authMiddleware, async (req, res) => {
  const { role, email } = req.user;
  if (role === 'agent') return res.json([]);
  let query = supabase.from('users').select('id,name,email,account_email,role').eq('is_active', true);
  if (role === 'manager') query = query.eq('manager_email', email);
  const { data } = await query;
  res.json(data || []);
});

// ─── ADMIN: LIST ALL USERS ───────────────────────────────────────
app.get('/api/admin/users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'senior_manager') return res.status(403).json({ error: 'Forbidden' });
  const { data } = await supabase.from('users').select('id,name,email,account_email,role,is_active').order('name');
  res.json(data || []);
});

// ─── ADMIN: UPDATE USER ──────────────────────────────────────────
app.patch('/api/admin/users/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'senior_manager') return res.status(403).json({ error: 'Forbidden' });
  const { role, is_active, manager_email } = req.body;
  const updates = {};
  if (role) updates.role = role;
  if (typeof is_active === 'boolean') updates.is_active = is_active;
  if (manager_email !== undefined) updates.manager_email = manager_email;
  await supabase.from('users').update(updates).eq('id', req.params.id);
  res.json({ success: true });
});

// ─── WEEKLY REPORT ───────────────────────────────────────────────
app.get('/api/report/weekly/:agentEmail', authMiddleware, async (req, res) => {
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
  const { data: all } = await supabase.from('emails').select('*').eq('account', req.params.agentEmail).gte('received_at', weekStart.toISOString());
  const { data: unreplied } = await supabase.from('emails').select('*').eq('account', req.params.agentEmail).eq('status', 'unreplied').gte('received_at', weekStart.toISOString());
  res.json({ total: all?.length || 0, replied: (all?.length || 0) - (unreplied?.length || 0), unreplied: unreplied?.length || 0, unrepliedEmails: unreplied || [] });
});

// ─── MANUAL TRIGGER ──────────────────────────────────────────────
app.post('/api/trigger/fetch', authMiddleware, async (req, res) => {
  runGmailFetcher().catch(console.error);
  res.json({ message: 'Fetch triggered' });
});

// ─── FALLBACK ────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

// ─── CRON JOBS ───────────────────────────────────────────────────
cron.schedule('*/5 * * * *', () => runGmailFetcher().catch(console.error));
cron.schedule('30 3 * * *', async () => { await sendDailyAgentReminders(); await sendDailyManagerReminders(); });
cron.schedule('30 4 * * 6', () => sendWeeklyReports().catch(console.error));

app.listen(process.env.PORT || 3000, () => {
  console.log(`✅ Server running on port ${process.env.PORT || 3000}`);
  setTimeout(() => runGmailFetcher().catch(console.error), 5000);
});
