// backend/aiClassifier.js
// Uses Claude API to decide if an email needs a reply or not

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Asks Claude whether this email needs a reply.
 * Returns: { needs_reply: bool, reason: string, confidence: 'high'|'medium'|'low' }
 */
async function classifyEmail({ senderEmail, senderName, subject, bodyPreview, toHeader, ccHeader, accountEmail }) {
  const isInCc = ccHeader && ccHeader.toLowerCase().includes(accountEmail.toLowerCase()) &&
                 !(toHeader && toHeader.toLowerCase().includes(accountEmail.toLowerCase()));

  const prompt = `You are an email classifier for a textile export company (Kishor Exports, India).

Analyze this email and decide if the recipient needs to send a reply.

EMAIL DETAILS:
- From: ${senderName} <${senderEmail}>
- To: ${toHeader || '(unknown)'}
- CC: ${ccHeader || '(none)'}
- Our account: ${accountEmail}
- In CC only: ${isInCc ? 'YES' : 'NO'}
- Subject: ${subject}
- Preview: ${bodyPreview}

REPLY IS NOT NEEDED if:
- It's a bank alert, OTP, transaction notification, account statement
- It's a newsletter, promotional, or marketing email
- It's an automated system notification (shipping update, order confirmation, welcome email)
- It's an auto-reply or out-of-office message
- The person is only CC'd and it's clearly just an FYI with no question directed at them
- It's a social media notification (LinkedIn, Twitter, etc.)
- It's an internal automated report or digest

REPLY IS NEEDED if:
- A real person (buyer, supplier, client, partner) is asking a question
- A client is following up on an order, shipment, payment, or inquiry
- Someone needs confirmation, approval, or information from us
- Even if in CC — if a question is clearly directed at them or their team
- A complaint or concern that needs acknowledgment

Respond ONLY with valid JSON, no explanation, no markdown:
{"needs_reply": true/false, "reason": "one sentence explaining why", "confidence": "high/medium/low"}`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        // API key injected by Railway env var ANTHROPIC_API_KEY
        'x-api-key': process.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // cheapest + fastest for classification
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      console.error(`[AI] API error ${response.status}`);
      return null; // fall back to default (unreplied)
    }

    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      needs_reply: parsed.needs_reply === true,
      reason: parsed.reason || '',
      confidence: parsed.confidence || 'medium'
    };
  } catch (err) {
    console.error('[AI] Classification error:', err.message);
    return null; // on any error, default to needs reply (safer)
  }
}

module.exports = { classifyEmail };
