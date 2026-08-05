const MAX_REQUESTS = 15;
const WINDOW_MINUTES = 5;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Simple per-IP rate limit backed by a small Supabase table (see migration notes).
// Returns true if this request is allowed to proceed.
async function checkRateLimit(ip) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const key = `chat:${ip}`;
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/rate_limit_events?key=eq.${encodeURIComponent(key)}&created_at=gte.${since}&select=id`,
      { headers }
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (rows.length >= MAX_REQUESTS) return false;
    }
  } catch (e) {
    console.error('chat rate limit check failed:', e.message);
    return true; // fail open on infra errors — a Supabase hiccup shouldn't lock out real users
  }

  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limit_events`, {
      method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ key }),
    });
  } catch (e) {
    console.error('chat rate limit record failed:', e.message);
  }
  return true;
}

// Self-hosted error monitoring: logs to a Supabase table and sends a WhatsApp
// alert to the admin, at most once per 15 minutes per source, so a real problem
// gets noticed without spamming the phone on repeated/flapping errors.
async function logError(source, error) {
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
    const message = (error?.message || String(error)).slice(0, 2000);
    const stack = (error?.stack || '').slice(0, 4000);

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const recentResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/error_logs?source=eq.${encodeURIComponent(source)}&created_at=gte.${since}&select=id&limit=1`,
      { headers }
    );
    const recentRows = recentResp.ok ? await recentResp.json() : [];
    const shouldAlert = recentRows.length === 0;

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/error_logs`, {
      method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ source, message, stack }),
    });

    if (shouldAlert && process.env.ADMIN_WHATSAPP_NUMBER && process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
      const digits = String(process.env.ADMIN_WHATSAPP_NUMBER).replace(/\D/g, '');
      const e164 = digits.startsWith('234') ? digits : digits.startsWith('0') ? '234' + digits.slice(1) : digits;
      await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: e164, type: 'text',
          text: { body: `🚨 NaijaNest error in ${source}:\n${message.slice(0, 300)}` },
        }),
      });
    }
  } catch (e) {
    console.error('logError itself failed:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return res.status(200).json({
      content: [{ type: 'text', text: "You're sending messages a bit quickly — please wait a minute and try again 🙏" }]
    });
  }

  const { messages, system } = req.body;
  const truncatedSystem = system && system.length > 8000 ? system.substring(0, 8000) : system;
  const groqMessages = [{ role: 'system', content: truncatedSystem }, ...messages];

  // Try primary model first, fall back to backup if rate limited
  const models = [
    'llama-3.3-70b-versatile',  // Primary - smarter
    'llama-3.1-8b-instant',     // Backup - faster, uses fewer tokens
    'gemma2-9b-it'              // Last resort
  ];

  for (const model of models) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          max_tokens: 800,
          temperature: 0.2,
          messages: groqMessages
        })
      });

      const data = await response.json();

      // If rate limited, try next model
      if (!response.ok) {
        const errorCode = data?.error?.code;
        if (errorCode === 'rate_limit_exceeded') {
          console.log(`Model ${model} rate limited, trying next...`);
          continue; // Try next model
        }
        // Other error - return friendly message
        console.error(`Model ${model} error:`, JSON.stringify(data));
        await logError('chat', new Error(`Groq API error on ${model}: ${JSON.stringify(data?.error || data)}`));
        return res.status(200).json({
          content: [{ type: 'text', text: 'Hi! 👋 Our AI assistant is taking a short break. Please try again in a few minutes 🙏' }]
        });
      }

      const text = data.choices?.[0]?.message?.content || 'Sorry, please try again.';
      console.log(`Responded using model: ${model}`);
      return res.status(200).json({ content: [{ type: 'text', text }] });

    } catch (error) {
      console.error(`Error with model ${model}:`, error.message);
      continue; // Try next model
    }
  }

  // All models failed
  await logError('chat', new Error('All Groq models failed or were rate-limited'));
  return res.status(200).json({
    content: [{ type: 'text', text: 'Hi! 👋 Our AI assistant is taking a short break right now. Please try again in a few minutes 🙏' }]
  });
}
