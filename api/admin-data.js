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

// Same release logic as paystack-verify.js's releaseEscrow — duplicated rather
// than shared, since sharing would mean a /lib import; both copies stay in
// sync manually (search for "releaseEscrowFunds" if you change one). The one
// difference: this version also accepts 'disputed' as a startable state,
// since it's only ever called here after an admin has resolved a dispute
// in the renter's favor of "actually just release it".
async function releaseEscrowFunds({ escrow, headers }) {
  if (!['funded', 'confirmed', 'disputed'].includes(escrow.status)) {
    return { skipped: true };
  }

  const landlordResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.landlord_id}` +
    `&select=id,bank_code,bank_account_number,bank_account_name,paystack_recipient_code`,
    { headers }
  );
  const landlords = await landlordResp.json();
  const landlord = landlords[0];
  if (!landlord || !landlord.bank_account_number) {
    throw new Error(`Landlord ${escrow.landlord_id} has no bank details on file`);
  }

  let recipientCode = landlord.paystack_recipient_code;
  if (!recipientCode) {
    const recResp = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'nuban', name: landlord.bank_account_name,
        account_number: landlord.bank_account_number, bank_code: landlord.bank_code,
        currency: 'NGN',
      }),
    });
    const recData = await recResp.json();
    if (!recData.status) throw new Error(`Could not create Paystack recipient: ${recData.message}`);
    recipientCode = recData.data.recipient_code;
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.landlord_id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ paystack_recipient_code: recipientCode }),
    });
  }

  const transferRef = `naijanest_payout_${escrow.id}_${Date.now()}`;
  const transferResp = await fetch('https://api.paystack.co/transfer', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'balance', amount: escrow.rent_amount, recipient: recipientCode,
      reference: transferRef, reason: `NaijaNest rent payout — escrow ${escrow.id}`,
    }),
  });
  const transferData = await transferResp.json();
  if (!transferData.status) throw new Error(`Transfer failed: ${transferData.message}`);

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      status: 'released', released_at: new Date().toISOString(),
      transfer_reference: transferRef, transfer_code: transferData.data.transfer_code,
    }),
  });
}

// Admin resolves a dispute a renter raised (see raise_dispute in
// paystack-verify.js): either release the rent to the landlord after all
// (e.g. renter's complaint didn't hold up), or refund the renter in full via
// Paystack's Refund API (e.g. the listing turned out to be fraudulent, or the
// landlord never handed over keys). This is the ONLY path that can move a
// 'disputed' row forward — nothing automated touches it.
async function resolveEscrowDispute(req, res, serviceKey) {
  const { escrow_id, resolution, admin_notes } = req.body || {};
  if (!escrow_id || !['release', 'refund'].includes(resolution)) {
    return res.status(400).json({ error: 'Missing escrow_id or invalid resolution (must be "release" or "refund")' });
  }

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const escrowResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}&select=*`, { headers }
  );
  const rows = await escrowResp.json();
  const escrow = rows[0];
  if (!escrow) return res.status(404).json({ error: 'Escrow record not found' });
  if (escrow.status !== 'disputed') {
    return res.status(400).json({ error: `Can only resolve disputed escrows — current status is ${escrow.status}` });
  }

  if (resolution === 'release') {
    try {
      await releaseEscrowFunds({ escrow, headers });
    } catch (e) {
      return res.status(400).json({ error: `Release failed: ${e.message}` });
    }
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ resolved_by_admin_at: new Date().toISOString(), admin_notes: admin_notes || null }),
    });
    return res.status(200).json({ success: true, resolution: 'released' });
  }

  const refundResp = await fetch('https://api.paystack.co/refund', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: escrow.reference, amount: escrow.total_amount }),
  });
  const refundData = await refundResp.json();
  if (!refundData.status) {
    return res.status(400).json({ error: `Refund failed: ${refundData.message}` });
  }

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      status: 'refunded', refunded_at: new Date().toISOString(),
      resolved_by_admin_at: new Date().toISOString(), admin_notes: admin_notes || null,
    }),
  });

  return res.status(200).json({ success: true, resolution: 'refunded' });
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
    const { admin_password, action } = req.body || {};
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set' });
    }

    const auth = await checkAdminAuth(req, admin_password, serviceKey);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    if (action === 'resolve_escrow_dispute') {
      return await resolveEscrowDispute(req, res, serviceKey);
    }

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    };

    const [propsResp, waitlistResp, paymentsResp, eventsResp, errorsResp, escrowResp] = await Promise.all([
      fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?order=created_at.desc`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist?order=created_at.desc`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/payments?order=created_at.desc`, { headers }),
      // rate_limit_events was built for rate-limiting (see chat.js/whatsapp-webhook.js) but
      // nothing ever deletes old rows, so it doubles as a full usage log: one row per
      // chat.js or whatsapp-webhook.js message ever sent. Only pulling the last 90 days
      // and two columns keeps this cheap even as it grows.
      fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limit_events?select=key,created_at&created_at=gte.${new Date(Date.now() - 90*24*60*60*1000).toISOString()}&order=created_at.desc`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/error_logs?order=created_at.desc&limit=100`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?order=created_at.desc&limit=200`, { headers }),
    ]);

    if (!propsResp.ok) {
      const err = await propsResp.text();
      return res.status(400).json({ error: `properties: ${err}` });
    }
    if (!waitlistResp.ok) {
      const err = await waitlistResp.text();
      return res.status(400).json({ error: `waitlist: ${err}` });
    }
    // payments/events/escrow tables are newer — don't hard-fail the whole dashboard if any
    // has an issue, just show empty data for that section.
    const properties = await propsResp.json();
    properties.forEach(p => { if (p.nin_number) p.nin_number = decryptNin(p.nin_number); });
    const waitlist = await waitlistResp.json();
    const payments = paymentsResp.ok ? await paymentsResp.json() : [];
    const events = eventsResp.ok ? await eventsResp.json() : [];
    const errors = errorsResp.ok ? await errorsResp.json() : [];
    const escrow = escrowResp.ok ? await escrowResp.json() : [];

    return res.status(200).json({ properties, waitlist, payments, events, errors, escrow });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
