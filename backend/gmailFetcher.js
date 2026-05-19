// backend/gmailFetcher.js
require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── SPAM / SYSTEM EMAIL DETECTION ────────────────────────────────
const SYSTEM_SENDER_KEYWORDS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'notification', 'notifications',
  'alert', 'alerts', 'automated', 'system', 'support',
  'newsletter', 'news', 'digest', 'update', 'updates',
  'billing', 'invoice', 'receipt', 'payment', 'order',
  'security', 'verify', 'verification', 'confirm', 'confirmation',
  'hello@notify', 'hello@news', 'hello@mail',
  'team@', 'info@', 'admin@',
];

const SYSTEM_SENDER_DOMAINS = [
  'railway.app', 'notify.railway.app', 'news.railway.app',
  'github.com', 'github.io', 'getgitguardian.com',
  'apollo.io', 'mail.apollo.io',
  'vultr.com',
  'anthropic.com',
  'google.com', 'accounts.google.com', 'googlemail.com',
  'dyad.sh',
  'linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'medium.com', 'substack.com',
  'mailchimp.com', 'sendgrid.net', 'amazonses.com',
  'hubspot.com', 'salesforce.com', 'zendesk.com',
  'notion.so', 'slack.com', 'zoom.us',
  'stripe.com', 'paypal.com', 'razorpay.com',
  'indiamart.com', 'tradeindia.com', 'alibaba.com',
];

const SYSTEM_SUBJECT_KEYWORDS = [
  'unsubscribe', 'newsletter', 'promotion', 'offer', 'deal',
  'discount', 'sale', '% off', 'free trial',
  'invoice', 'receipt', 'payment confirmation', 'order confirmation',
  'verify your', 'confirm your', 'activate your',
  'deployment', 'build failed', 'build success', 'crashed',
  'security alert', 'sign-in attempt', 'new sign-in',
  'welcome to', 'getting started', 'your account',
  'server activated', 'cloud server',
  'daily digest', 'weekly digest', 'monthly report',
];

const GMAIL_LABELS_TO_SKIP = ['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'SPAM'];

function isSystemGenerated(senderEmail, senderName, subject, labelIds = []) {
  const senderLower = (senderEmail || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();

  if (labelIds.some(l => GMAIL_LABELS_TO_SKIP.includes(l))) return true;

  const domain = senderLower.split('@')[1] || '';
  if (SYSTEM_SENDER_DOMAINS.some(d => domain.includes(d))) return true;
  if (SYSTEM_SENDER_KEYWORDS.some(k => senderLower.includes(k))) return true;
  if (SYSTEM_SUBJECT_KEYWORDS.some(k => subjectLower.includes(k))) return true;

  return false;
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// ── TOKEN STORAGE IN SUPABASE ─────────────────────────────────────
async function getTokenFromSupabase(accountEmail) {
  const { data, error } = await supabase
    .from('users')
    .select('gmail_token')
    .eq('email', accountEmail)
    .single();

  if (error || !data || !data.gmail_token) {
    console.log(`[Gmail] No token in Supabase for ${accountEmail}`);
    return null;
  }

  try {
    return typeof data.gmail_token === 'string'
      ? JSON.parse(data.gmail_token)
      : data.gmail_token;
  } catch {
    console.log(`[Gmail] Invalid token JSON for ${accountEmail}`);
    return null;
  }
}

async function saveTokenToSupabase(accountEmail, tokens) {
  const { error } = await supabase
    .from('users')
    .update({ gmail_token: JSON.stringify(tokens) })
    .eq('email', accountEmail);

  if (error) {
    console.error(`[Gmail] Failed to save token for ${accountEmail}:`, error.message);
  }
}

// ── FETCH EMAILS FOR ONE ACCOUNT ─────────────────────────────────
async function fetchGmailEmails(accountEmail) {
  const tokens = await getTokenFromSupabase(accountEmail);
  if (!tokens) return 0;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', async (newTokens) => {
    const updated = { ...tokens, ...newTokens };
    await saveTokenToSupabase(accountEmail, updated);
    console.log(`[Gmail] Token refreshed and saved for ${accountEmail}`);
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // ✅ FIXED: labelIds only — no 'q' param (incompatible with metadata scope)
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 100,
      labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
    });

    const messages = listRes.data.messages || [];
    console.log(`[Gmail] ${accountEmail}: Found ${messages.length} messages`);
    let saved = 0;

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID']
      });

      const headers = detail.data.payload?.headers || [];
      const labelIds = detail.data.labelIds || [];
      const from = getHeader(headers, 'From');
      const subject = getHeader(headers, 'Subject') || '(No Subject)';
      const date = getHeader(headers, 'Date');

      const emailMatch = from.match(/<(.+)>/);
      const senderEmail = emailMatch ? emailMatch[1] : from;
      const senderName = from.replace(/<.+>/, '').trim().replace(/"/g, '');

      const systemGenerated = isSystemGenerated(senderEmail, senderName, subject, labelIds);
      const receivedAt = date ? new Date(date).toISOString() : new Date().toISOString();

      const emailData = {
        email_id: msg.id,
        thread_id: detail.data.threadId,
        account: accountEmail,
        source: 'gmail',
        sender_name: senderName,
        sender_email: senderEmail,
        subject: subject,
        body_preview: detail.data.snippet || '',
        email_link: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
        received_at: receivedAt,
        status: systemGenerated ? 'system_generated' : 'unreplied',
        is_system_generated: systemGenerated
      };

      const { error } = await supabase
        .from('emails')
        .upsert(emailData, { onConflict: 'email_id', ignoreDuplicates: true });

      if (!error) saved++;
    }

    console.log(`[Gmail] ${accountEmail}: ${saved} emails saved to Supabase`);
    await checkGmailReplies(accountEmail, gmail);
    return saved;

  } catch (err) {
    console.error(`[Gmail] Error for ${accountEmail}:`, err.message);
    return 0;
  }
}

// ── CHECK REPLIES ─────────────────────────────────────────────────
async function checkGmailReplies(accountEmail, gmail) {
  try {
    const since = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

    // ✅ FIXED: No 'q' param on sent list either
    const sentRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 100,
      labelIds: ['SENT'],
    });

    const sentMessages = sentRes.data.messages || [];
    if (sentMessages.length === 0) return;

    const threadIds = [];
    for (const msg of sentMessages.slice(0, 30)) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'minimal'
      });
      const internalDate = parseInt(detail.data.internalDate || '0');
      if (internalDate > since * 1000 && detail.data.threadId) {
        threadIds.push(detail.data.threadId);
      }
    }

    if (threadIds.length === 0) return;

    const { data: unreplied } = await supabase
      .from('emails')
      .select('id')
      .eq('account', accountEmail)
      .eq('status', 'unreplied')
      .in('thread_id', threadIds);

    if (unreplied && unreplied.length > 0) {
      const ids = unreplied.map(e => e.id);
      await supabase
        .from('emails')
        .update({
          status: 'replied',
          replied_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .in('id', ids);
      console.log(`[Gmail] ${accountEmail}: ${ids.length} marked as replied`);
    }
  } catch (err) {
    console.error(`[Gmail] Reply check error for ${accountEmail}:`, err.message);
  }
}

// ── MAIN: FETCH ALL CONNECTED ACCOUNTS ───────────────────────────
async function runGmailFetcher() {
  const { data: users, error } = await supabase
    .from('users')
    .select('email, gmail_token')
    .not('gmail_token', 'is', null);

  if (error) {
    console.error('[Gmail] Failed to fetch users from Supabase:', error.message);
    return;
  }

  const envAccounts = (process.env.GMAIL_ACCOUNTS || '').split(',').map(e => e.trim()).filter(Boolean);
  const supabaseAccounts = (users || []).map(u => u.email);
  const allAccounts = [...new Set([...supabaseAccounts, ...envAccounts])];

  if (allAccounts.length === 0) {
    console.log('[Gmail] No connected accounts found');
    return;
  }

  console.log(`[Gmail] Fetching ${allAccounts.length} accounts: ${allAccounts.join(', ')}`);
  for (const account of allAccounts) {
    await fetchGmailEmails(account);
  }
  console.log('[Gmail] Done.');
}

module.exports = { runGmailFetcher, saveTokenToSupabase };
