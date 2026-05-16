// backend/gmailFetcher.js
require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TOKENS_DIR = path.join(__dirname, '../tokens');

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
  const nameLower = (senderName || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();

  // Check Gmail category labels
  if (labelIds.some(l => GMAIL_LABELS_TO_SKIP.includes(l))) return true;

  // Check sender domain
  const domain = senderLower.split('@')[1] || '';
  if (SYSTEM_SENDER_DOMAINS.some(d => domain.includes(d))) return true;

  // Check sender email keywords
  if (SYSTEM_SENDER_KEYWORDS.some(k => senderLower.includes(k))) return true;

  // Check subject keywords
  if (SYSTEM_SUBJECT_KEYWORDS.some(k => subjectLower.includes(k))) return true;

  return false;
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// ── FETCH EMAILS FOR ONE ACCOUNT ─────────────────────────────────
async function fetchGmailEmails(accountEmail) {
  const tokenFile = path.join(TOKENS_DIR, `${accountEmail}.json`);
  if (!fs.existsSync(tokenFile)) {
    console.log(`[Gmail] No token for ${accountEmail} — skipping`);
    return 0;
  }

  const tokens = JSON.parse(fs.readFileSync(tokenFile));
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  oauth2Client.setCredentials(tokens);

  // Auto-refresh token
  oauth2Client.on('tokens', (newTokens) => {
    const updated = { ...tokens, ...newTokens };
    fs.writeFileSync(tokenFile, JSON.stringify(updated));
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // Only fetch PRIMARY inbox (excludes promotions/updates/social automatically)
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 50,
      labelIds: ['INBOX'],
      q: 'category:primary'  // ← only primary tab emails
    });

    const messages = listRes.data.messages || [];
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

      // Parse sender
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

    console.log(`[Gmail] ${accountEmail}: ${saved} emails processed`);
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
    const sentRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 100,
      labelIds: ['SENT'],
      q: `after:${since}`
    });

    const sentMessages = sentRes.data.messages || [];
    if (sentMessages.length === 0) return;

    const threadIds = [];
    for (const msg of sentMessages.slice(0, 30)) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'minimal'
      });
      if (detail.data.threadId) threadIds.push(detail.data.threadId);
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
  if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });

  // Get all accounts that have token files (connected via OAuth)
  const tokenFiles = fs.readdirSync(TOKENS_DIR).filter(f => f.endsWith('.json'));
  const oauthAccounts = tokenFiles.map(f => f.replace('.json', ''));

  // Also include any hardcoded accounts from env
  const envAccounts = (process.env.GMAIL_ACCOUNTS || '').split(',').map(e => e.trim()).filter(Boolean);

  // Merge, deduplicate
  const allAccounts = [...new Set([...oauthAccounts, ...envAccounts])];

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

module.exports = { runGmailFetcher };
