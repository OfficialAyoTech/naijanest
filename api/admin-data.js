import crypto from 'crypto';

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Compares two strings without leaking timing info about how many characters matched.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // keep timing consistent even on length mismatch
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Checks the admin password with brute-force protection: blocks after MAX_ATTEMPTS
// failed tries from the same IP within WINDOW_MINUTES. Logs failures to the
// admin_login_attempts table (see migration notes in README).
async function checkAdminAuth(req, providedPassword, serviceKey) {
  const ip = getClientIp(req);
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/admin_login_attempts?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${since}&select=id`,
      { headers }
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (rows.length >= MAX_ATTEMPTS) {
        return { ok: false, status: 429, error: 'Too many failed attempts. Try again in a few minutes.' };
      }
    }
  } catch (e) {
    console.error('admin auth: rate-limit check failed:', e.message);
    // Fail open on infra errors so a Supabase hiccup doesn't lock out a legitimate
    // admin forever — the password check below still fully protects the endpoint.
  }

  const correct = safeCompare(providedPassword, process.env.ADMIN_PASSWORD);
  if (!correct) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/admin_login_attempts`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ ip }),
      });
    } catch (e) {
      console.error('admin auth: failed to log attempt:', e.message);
    }
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

// Decrypts a NIN that was encrypted by submit-property.js's encryptNin(). Rows
// created before encryption was added are still plain 11-digit strings — those
// pass through unchanged rather than erroring, so old and new listings both work.
function decryptNin(value) {
  if (typeof value !== 'string') return value;
  const parts = value.split(':');
  if (parts.length !== 3) return value; // not our encrypted format — legacy plaintext
  try {
    const [ivHex, authTagHex, dataHex] = parts;
    const key = Buffer.from(process.env.NIN_ENCRYPTION_KEY, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    console.error('admin-data: NIN decrypt failed:', e.message);
    return '[decryption error]';
  }
}

// Returns ALL properties + waitlist data for the admin dashboard.
// Gated by ADMIN_PASSWORD (checked server-side, never trust the client),
// with brute-force protection (rate limiting + constant-time comparison).
// Uses SUPABASE_SERVICE_ROLE_KEY so this works even after RLS locks the
// anon key down to "approved properties only" (see migration notes).
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { admin_password } = req.body || {};
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set' });
    }

    const auth = await checkAdminAuth(req, admin_password, serviceKey);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    };

    const [propsResp, waitlistResp, paymentsResp, eventsResp, errorsResp] = await Promise.all([
      fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?order=created_at.desc`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist?order=created_at.desc`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/payments?order=created_at.desc`, { headers }),
      // rate_limit_events was built for rate-limiting (see chat.js/whatsapp-webhook.js) but
      // nothing ever deletes old rows, so it doubles as a full usage log: one row per
      // chat.js or whatsapp-webhook.js message ever sent. Only pulling the last 90 days
      // and two columns keeps this cheap even as it grows.
      fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limit_events?select=key,created_at&created_at=gte.${new Date(Date.now() - 90*24*60*60*1000).toISOString()}&order=created_at.desc`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/error_logs?order=created_at.desc&limit=100`, { headers }),
    ]);

    if (!propsResp.ok) {
      const err = await propsResp.text();
      return res.status(400).json({ error: `properties: ${err}` });
    }
    if (!waitlistResp.ok) {
      const err = await waitlistResp.text();
      return res.status(400).json({ error: `waitlist: ${err}` });
    }
    // payments/events tables are newer — don't hard-fail the whole dashboard if either
    // has an issue, just show empty data for that section.
    const properties = await propsResp.json();
    properties.forEach(p => { if (p.nin_number) p.nin_number = decryptNin(p.nin_number); });
    const waitlist = await waitlistResp.json();
    const payments = paymentsResp.ok ? await paymentsResp.json() : [];
    const events = eventsResp.ok ? await eventsResp.json() : [];
    const errors = errorsResp.ok ? await errorsResp.json() : [];

    return res.status(200).json({ properties, waitlist, payments, events, errors });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
