// backend/gmailFetcher.js
// Fetches emails from Gmail accounts using stored OAuth tokens

require('dotenv').config();
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TOKENS_DIR = path.join(__dirname, '../tokens');

function isSystemGenerated(sender, subject) {
  const systemKeywords = ['noreply', 'no-reply', 'donotreply', 'mailer-daemon',
    'postmaster', 'notification', 'alert', 'automated', 'system'];
  const senderLower = (sender || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();
  return systemKeywords.some(k => senderLower.includes(k) || subjectLower.includes(k));
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

async function fetchGmailEmails(accountEmail) {
  const tokenFile = path.join(TOKENS_DIR, `${accountEmail}.json`);
  if (!fs.existsSync(tokenFile)) {
    console.log(`[Gmail] No token found for ${accountEmail} — needs OAuth setup`);
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
    // Get inbox messages
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 50,
      labelIds: ['INBOX']
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
      const from = getHeader(headers, 'From');
      const subject = getHeader(headers, 'Subject') || '(No Subject)';
      const date = getHeader(headers, 'Date');

      // Parse sender
      const emailMatch = from.match(/<(.+)>/);
      const senderEmail = emailMatch ? emailMatch[1] : from;
      const senderName = from.replace(/<.+>/, '').trim().replace(/"/g, '');

      const systemGenerated = isSystemGenerated(senderEmail, subject);
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

    console.log(`[Gmail] ${accountEmail}: ${saved} emails saved`);

    // Check replies — look at SENT folder
    await checkGmailReplies(accountEmail, gmail);

    return saved;
  } catch (err) {
    console.error(`[Gmail] Error for ${accountEmail}:`, err.message);
    return 0;
  }
}

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

    // Get thread IDs of sent messages
    const threadIds = [];
    for (const msg of sentMessages.slice(0, 20)) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'minimal'
      });
      if (detail.data.threadId) threadIds.push(detail.data.threadId);
    }

    if (threadIds.length === 0) return;

    // Mark matching unreplied emails as replied
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
        .update({ status: 'replied', replied_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .in('id', ids);

      console.log(`[Gmail] ${accountEmail}: ${ids.length} marked as replied`);
    }
  } catch (err) {
    console.error(`[Gmail] Reply check error for ${accountEmail}:`, err.message);
  }
}

async function runGmailFetcher() {
  const accounts = (process.env.GMAIL_ACCOUNTS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (accounts.length === 0) {
    console.log('[Gmail] No accounts configured');
    return;
  }

  if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });

  console.log(`[Gmail] Fetching ${accounts.length} accounts...`);
  for (const account of accounts) {
    await fetchGmailEmails(account);
  }
  console.log('[Gmail] Done.');
}

module.exports = { runGmailFetcher };
