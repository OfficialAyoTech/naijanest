import crypto from 'crypto';

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function safeCompareStr(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Same admin-password check as submit-property.js's checkAdminAuth — kept
// as a local copy here rather than importing it, since that function isn't
// currently exported from submit-property.js. Rate-limits failed admin
// password attempts per IP against the same admin_login_attempts table, so
// a brute-force attempt against this endpoint counts toward the same
// lockout as attempts against submit-property.js.
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
    console.error('upload-photo auth: rate-limit check failed:', e.message);
  }
  const correct = safeCompareStr(providedPassword, process.env.ADMIN_PASSWORD);
  if (!correct) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/admin_login_attempts`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ ip }),
      });
    } catch (e) {
      console.error('upload-photo auth: failed to log attempt:', e.message);
    }
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { data, mimeType, access_token, admin_password } = req.body || {};

    // Two ways in, same pattern as submit-property.js: a signed-in landlord's
    // access_token, or the admin password (Quick Add tool). Previously this
    // endpoint only checked access_token, so Quick Add uploads always failed
    // with "Please sign in" even while logged into the admin dashboard.
    if (admin_password) {
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const auth = await checkAdminAuth(req, admin_password, serviceKey);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    } else {
      if (!access_token) {
        return res.status(401).json({ error: 'Please sign in to upload photos' });
      }
      const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
      });
      if (!userResp.ok) {
        return res.status(401).json({ error: 'Your session has expired - please sign in again' });
      }
    }

    if (!data || !mimeType) {
      return res.status(400).json({ error: 'Missing image data or mimeType' });
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      return res.status(400).json({ error: 'Unsupported image type' });
    }
    const buffer = Buffer.from(data, 'base64');
    const MAX_BYTES = 2.5 * 1024 * 1024;
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ error: 'Image too large - please try a smaller photo' });
    }
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const uploadResp = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/property-photos/${path}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': mimeType,
        },
        body: buffer,
      }
    );
    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      return res.status(400).json({ error: err });
    }
    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/property-photos/${path}`;
    return res.status(200).json({ success: true, url: publicUrl });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
