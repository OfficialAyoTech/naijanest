import crypto from 'crypto';

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

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
    console.error('delete-property auth: rate-limit check failed:', e.message);
  }

  const correct = safeCompare(providedPassword, process.env.ADMIN_PASSWORD);
  if (!correct) {
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/admin_login_attempts`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ ip }),
      });
    } catch (e) {
      console.error('delete-property auth: failed to log attempt:', e.message);
    }
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

// Permanently deletes a property row AND its uploaded photos from storage.
// This is deliberately separate from "mark as rented" (see approve-property.js) —
// rented properties should stay in the database as a record; this endpoint is for
// removing junk (demo data, spam, test listings) that should never come back.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { id, admin_password } = req.body || {};
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set' });
    }
    if (!id) {
      return res.status(400).json({ error: 'Missing property id' });
    }

    const auth = await checkAdminAuth(req, admin_password, serviceKey);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

    // Fetch the photo URLs first so we can clean up storage after the row is gone.
    const propResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${id}&select=photo_urls`,
      { headers }
    );
    const propRows = await propResp.json();
    const photoUrls = Array.isArray(propRows[0]?.photo_urls) ? propRows[0].photo_urls : [];

    const deleteResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${id}`, {
      method: 'DELETE',
      headers: { ...headers, Prefer: 'return=minimal' },
    });
    if (!deleteResp.ok) {
      const err = await deleteResp.text();
      return res.status(400).json({ error: err });
    }

    // Best-effort photo cleanup — never let a storage hiccup undo the fact that
    // the property record itself was already successfully deleted.
    const bucketPrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/property-photos/`;
    for (const url of photoUrls) {
      if (typeof url !== 'string' || !url.startsWith(bucketPrefix)) continue;
      const path = url.slice(bucketPrefix.length);
      try {
        await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/property-photos/${path}`, {
          method: 'DELETE',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        });
      } catch (e) {
        console.error('delete-property: failed to delete photo', path, e.message);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
