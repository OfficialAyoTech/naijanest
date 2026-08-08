import crypto from 'crypto';
import { logError } from '../lib/notify.js';

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
    console.error('admin auth: rate-limit check failed:', e.message);
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { id, status, admin_password, action } = req.body;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const auth = await checkAdminAuth(req, admin_password, serviceKey);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const headers = { 'Content-Type': 'application/json', 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` };

    // action:'delete' permanently removes the property (and its photos). Kept in this
    // same function, not a separate file, because Vercel's Hobby plan caps a deployment
    // at 12 serverless functions — merging this in keeps us under that limit instead of
    // adding a 13th route.
    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'Missing property id' });

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
          console.error('approve-property (delete): failed to delete photo', path, e.message);
        }
      }

      return res.status(200).json({ success: true });
    }

    // Default behavior: update status (approve / reject / unpublish / mark rented).
    const ALLOWED_STATUSES = ['pending', 'approved', 'rejected', 'rented'];
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    // Fetch details first so we can notify the landlord after a successful update
    const propResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${id}&select=name,landlord_name,landlord_phone`,
      { headers }
    );
    const propRows = await propResp.json();
    const property = propRows[0];

    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status })
    });
    if (!response.ok) { const err = await response.text(); return res.status(400).json({ error: err }); }

    // Best-effort WhatsApp notification — never let this fail the approve/reject action itself.
    // Awaited (not fire-and-forget) because Vercel can freeze the function shortly after
    // the response is sent, which would kill an in-flight, un-awaited request.
    if (property && (status === 'approved' || status === 'rejected')) {
      try {
        await notifyLandlord(property, status);
      } catch (e) {
        console.error('WhatsApp notify failed:', e.message);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    await logError('approve-property', error);
    return res.status(500).json({ error: error.message });
  }
}

// Sends a pre-approved WhatsApp template ("listing_status_update") to the landlord.
// Requires WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID env vars and the template to be
// approved in Meta's WhatsApp Manager. Silently no-ops if not configured or no phone.
async function notifyLandlord(property, status) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) return;
  if (!property.landlord_phone) return;

  const digits = String(property.landlord_phone).replace(/\D/g, '');
  const e164 = digits.startsWith('234') ? digits : digits.startsWith('0') ? '234' + digits.slice(1) : digits;

  const statusText = status === 'approved' ? 'approved and is now live!' : 'not approved this time';
  const closingText = status === 'approved'
    ? 'View it at naijanest.vercel.app'
    : 'Contact support if you have questions.';

  await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: e164,
      type: 'template',
      template: {
        name: 'listing_status_update',
        language: { code: 'en' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: property.landlord_name || 'there' },
            { type: 'text', text: property.name },
            { type: 'text', text: statusText },
            { type: 'text', text: closingText },
          ],
        }],
      },
    }),
  });
}
