import { logError } from '../lib/notify.js';

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


function formatRetryWait(seconds) {
  if (!seconds || seconds <= 0) return 'a moment';
  if (seconds < 60) return `about ${Math.ceil(seconds)} second${seconds >= 1.5 ? 's' : ''}`;
  const mins = Math.ceil(seconds / 60);
  return `about ${mins} minute${mins > 1 ? 's' : ''}`;
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
      content: [{ type: 'text', text: "Whoa, one at a time! 😅 You're chatting a bit fast for me to keep up. Give me about a minute to catch my breath, then try again — I'll be right here 🙏" }]
    });
  }

  const { messages, system } = req.body;
  const truncatedSystem = system && system.length > 8000 ? system.substring(0, 8000) : system;
  const groqMessages = [{ role: 'system', content: truncatedSystem }, ...messages];

  // Try primary model first, fall back to backup if rate limited
  const models = [
    'openai/gpt-oss-120b',   // Primary - smarter (replaces deprecated llama-3.3-70b-versatile)
    'qwen/qwen3.6-27b',      // Backup - fast, strong reasoning/coding
    'openai/gpt-oss-20b'     // Last resort - smaller, fastest, cheapest
  ];

  let lastRetryAfterSeconds = null;

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
          // Groq sends a retry-after header (seconds) on 429s — capture it so
          // that if every model ends up rate limited, we can tell the user a
          // real wait time instead of a generic "try later".
          const headerRetry = parseFloat(response.headers.get('retry-after'));
          if (!isNaN(headerRetry)) {
            lastRetryAfterSeconds = headerRetry;
          } else {
            // Fallback: Groq's error message sometimes embeds it, e.g.
            // "Please try again in 6m 11.52s."
            const msgMatch = /try again in (?:(\d+)m\s*)?([\d.]+)s/i.exec(data?.error?.message || '');
            if (msgMatch) {
              const mins = msgMatch[1] ? parseInt(msgMatch[1], 10) : 0;
              const secs = parseFloat(msgMatch[2]);
              lastRetryAfterSeconds = mins * 60 + secs;
            }
          }
          continue; // Try next model
        }
        // Other error - return friendly message
        console.error(`Model ${model} error:`, JSON.stringify(data));
        await logError('chat', new Error(`Groq API error on ${model}: ${JSON.stringify(data?.error || data)}`));
        return res.status(200).json({
          content: [{ type: 'text', text: "Hey! 👋 I'm having a small hiccup on my end right now — nothing wrong with your account or search, just me. Please try sending that again in a couple of minutes, I'll be back to normal 🙏 In the meantime, feel free to browse the listings on the homepage!" }]
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
  const waitText = lastRetryAfterSeconds ? formatRetryWait(lastRetryAfterSeconds) : 'a few minutes';
  return res.status(200).json({
    content: [{ type: 'text', text: `I'm sorry, I'm really swamped with chats right now and can't respond properly 😔 This is on my end, not yours. Please try again in ${waitText} — or, if you're in a hurry, you can browse verified listings directly on the homepage, or reach out through our Contact Support page and we'll help you find a place 🏡🙏` }]
  });
}