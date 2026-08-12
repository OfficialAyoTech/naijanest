import crypto from 'crypto';
import { logError, notifyRentReleased, notifyRenter, notifyLandlordCustom } from '../lib/notify.js';
import { releaseEscrow } from '../lib/escrow.js';

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
      await releaseEscrow({ escrow, headers });
    } catch (e) {
      await logError('escrow-dispute-release', new Error(`Escrow ${escrow.id} (${escrow.reference}): ${e.message}`));
      return res.status(400).json({ error: `Release failed: ${e.message}` });
    }
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ resolved_by_admin_at: new Date().toISOString(), admin_notes: admin_notes || null }),
    });
    // releaseEscrow() already notified the landlord (generic "released"
    // message) — the renter still needs to hear the dispute-specific outcome,
    // since they're the one who raised it.
    await notifyRenter(escrow, headers,
      `Your dispute has been reviewed. After looking into it, the payment was released to the landlord.`);
    return res.status(200).json({ success: true, resolution: 'released' });
  }

  const refundResp = await fetch('https://api.paystack.co/refund', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: escrow.reference, amount: escrow.total_amount }),
  });
  const refundData = await refundResp.json();
  if (!refundData.status) {
    await logError('escrow-dispute-refund', new Error(`Escrow ${escrow.id} (${escrow.reference}): ${refundData.message}`));
    return res.status(400).json({ error: `Refund failed: ${refundData.message}` });
  }

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      status: 'refunded', refunded_at: new Date().toISOString(),
      resolved_by_admin_at: new Date().toISOString(), admin_notes: admin_notes || null,
      // The Paystack refund above already covers the caution fee (it refunds
      // the whole original charge) — reflect that here so the Payments tab
      // doesn't keep showing it as separately "held".
      caution_fee_status: 'refunded', caution_settled_at: new Date().toISOString(),
    }),
  });

  const refundedAmount = (escrow.total_amount / 100).toLocaleString();
  await notifyRenter(escrow, headers,
    `Your dispute has been reviewed and you've been refunded ₦${refundedAmount} in full.`);
  await notifyLandlordCustom(escrow, headers,
    `A tenancy did not proceed and the renter's payment was refunded in full. Contact NaijaNest support if you have questions.`);

  return res.status(200).json({ success: true, resolution: 'refunded' });
}

// Settles the caution fee once a tenancy is over (told to you off-platform —
// there's no automated lease-end tracking). Only fires for a payment that
// actually completed (status 'released'); the caution fee sat untouched
// through the whole rent flow up to this point. Full refund or full forfeit
// only — no partial split for now.
// Marks a listing report as dismissed (not credible / already handled) or
// resolved (acted on — e.g. rejected the listing separately via the
// Submissions tab). This just clears it from the open-reports view; it
// doesn't itself touch the listing's status — that's a deliberate separate
// step so a report can't accidentally auto-reject something.
// FAQ management — the public-facing FAQ (index.html, both AI assistant
// prompts reference the same content conceptually) is readable by anyone
// directly via Supabase's anon key (RLS allows SELECT to everyone — see
// migration). Only these three actions, gated behind the admin password
// like everything else in this file, can actually change what's shown.
async function addFaq(req, res, serviceKey) {
  const { question, answer, sort_order } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: 'Missing question or answer' });
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/faq_entries`, {
    method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ question: String(question).slice(0, 500), answer: String(answer).slice(0, 3000), sort_order: Number(sort_order) || 0 }),
  });
  if (!resp.ok) return res.status(400).json({ error: `Could not add FAQ entry: ${await resp.text()}` });
  return res.status(200).json({ success: true });
}

async function updateFaq(req, res, serviceKey) {
  const { faq_id, question, answer, sort_order } = req.body || {};
  if (!faq_id) return res.status(400).json({ error: 'Missing faq_id' });
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const patch = { updated_at: new Date().toISOString() };
  if (question !== undefined) patch.question = String(question).slice(0, 500);
  if (answer !== undefined) patch.answer = String(answer).slice(0, 3000);
  if (sort_order !== undefined) patch.sort_order = Number(sort_order) || 0;
  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/faq_entries?id=eq.${faq_id}`, {
    method: 'PATCH', headers, body: JSON.stringify(patch),
  });
  if (!resp.ok) return res.status(400).json({ error: `Could not update FAQ entry: ${await resp.text()}` });
  return res.status(200).json({ success: true });
}

async function deleteFaq(req, res, serviceKey) {
  const { faq_id } = req.body || {};
  if (!faq_id) return res.status(400).json({ error: 'Missing faq_id' });
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/faq_entries?id=eq.${faq_id}`, {
    method: 'DELETE', headers,
  });
  if (!resp.ok) return res.status(400).json({ error: `Could not delete FAQ entry: ${await resp.text()}` });
  return res.status(200).json({ success: true });
}

async function resolveReport(req, res, serviceKey) {
  const { report_id, resolution, admin_notes } = req.body || {};
  if (!report_id || !['dismissed', 'resolved'].includes(resolution)) {
    return res.status(400).json({ error: 'Missing report_id or invalid resolution (must be "dismissed" or "resolved")' });
  }
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/listing_reports?id=eq.${report_id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ status: resolution, resolved_at: new Date().toISOString(), admin_notes: admin_notes || null }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    return res.status(400).json({ error: `Could not update report: ${err}` });
  }
  return res.status(200).json({ success: true });
}

async function resolveSupportMessage(req, res, serviceKey) {
  const { message_id, resolution, admin_notes } = req.body || {};
  if (!message_id || !['dismissed', 'resolved'].includes(resolution)) {
    return res.status(400).json({ error: 'Missing message_id or invalid resolution (must be "dismissed" or "resolved")' });
  }
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/support_messages?id=eq.${message_id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ status: resolution, resolved_at: new Date().toISOString(), admin_notes: admin_notes || null }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    return res.status(400).json({ error: `Could not update support message: ${err}` });
  }
  return res.status(200).json({ success: true });
}

async function settleCautionFee(req, res, serviceKey) {
  const { escrow_id, decision, admin_notes } = req.body || {};
  if (!escrow_id || !['refund', 'forfeit'].includes(decision)) {
    return res.status(400).json({ error: 'Missing escrow_id or invalid decision (must be "refund" or "forfeit")' });
  }

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const escrowResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}&select=*`, { headers }
  );
  const rows = await escrowResp.json();
  const escrow = rows[0];
  if (!escrow) return res.status(404).json({ error: 'Escrow record not found' });
  if (escrow.status !== 'released') {
    return res.status(400).json({ error: `Can only settle a caution fee for a released payment — current status is ${escrow.status}` });
  }
  if (escrow.caution_fee_status !== 'held') {
    return res.status(400).json({ error: `Caution fee already ${escrow.caution_fee_status}` });
  }
  if (!escrow.caution_fee_amount || escrow.caution_fee_amount <= 0) {
    return res.status(400).json({ error: 'This payment has no caution fee to settle' });
  }

  if (decision === 'refund') {
    // Partial refund of just the caution-fee portion of the original charge,
    // straight back to the renter's original payment method.
    const refundResp = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: escrow.reference, amount: escrow.caution_fee_amount }),
    });
    const refundData = await refundResp.json();
    if (!refundData.status) {
      await logError('caution-fee-refund', new Error(`Escrow ${escrow.id} (${escrow.reference}): ${refundData.message}`));
      return res.status(400).json({ error: `Refund failed: ${refundData.message}` });
    }

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({
        caution_fee_status: 'refunded', caution_settled_at: new Date().toISOString(),
        caution_settlement_notes: admin_notes || null,
      }),
    });
    const cautionAmt = (escrow.caution_fee_amount / 100).toLocaleString();
    await notifyRenter(escrow, headers, `Your caution fee of ₦${cautionAmt} has been refunded to you.`);
    return res.status(200).json({ success: true, decision: 'refunded' });
  }

  // decision === 'forfeit' — pay the caution fee to the landlord. Their
  // Paystack recipient already exists (rent was already transferred there
  // to reach 'released' status), so this reuses it directly.
  const landlordResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.landlord_id}&select=paystack_recipient_code`,
    { headers }
  );
  const landlords = await landlordResp.json();
  const recipientCode = landlords[0]?.paystack_recipient_code;
  if (!recipientCode) {
    return res.status(400).json({ error: 'Landlord has no Paystack recipient on file — this should not happen after a successful release. Check profiles table.' });
  }

  const transferRef = `naijanest_caution_${escrow.id}_${Date.now()}`;
  const transferResp = await fetch('https://api.paystack.co/transfer', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'balance', amount: escrow.caution_fee_amount, recipient: recipientCode,
      reference: transferRef, reason: `NaijaNest caution fee forfeiture — escrow ${escrow.id}`,
    }),
  });
  const transferData = await transferResp.json();
  if (!transferData.status) {
    await logError('caution-fee-forfeit', new Error(`Escrow ${escrow.id} (${escrow.reference}): ${transferData.message}`));
    return res.status(400).json({ error: `Transfer failed: ${transferData.message}` });
  }

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      caution_fee_status: 'forfeited', caution_settled_at: new Date().toISOString(),
      caution_settlement_notes: admin_notes || null,
    }),
  });
  const forfeitedAmt = (escrow.caution_fee_amount / 100).toLocaleString();
  await notifyRenter(escrow, headers, `Your caution fee of ₦${forfeitedAmt} has been forfeited to the landlord.`);
  await notifyLandlordCustom(escrow, headers, `A caution fee of ₦${forfeitedAmt} has been paid to you.`);
  return res.status(200).json({ success: true, decision: 'forfeited' });
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
    if (action === 'settle_caution_fee') {
      return await settleCautionFee(req, res, serviceKey);
    }
    if (action === 'resolve_report') {
      return await resolveReport(req, res, serviceKey);
    }
    if (action === 'resolve_support_message') {
      return await resolveSupportMessage(req, res, serviceKey);
    }
    if (action === 'add_faq') {
      return await addFaq(req, res, serviceKey);
    }
    if (action === 'update_faq') {
      return await updateFaq(req, res, serviceKey);
    }
    if (action === 'delete_faq') {
      return await deleteFaq(req, res, serviceKey);
    }

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    };

    const [propsResp, waitlistResp, paymentsResp, eventsResp, errorsResp, escrowResp, reportsResp, faqResp, supportResp] = await Promise.all([
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
      fetch(`${process.env.SUPABASE_URL}/rest/v1/listing_reports?order=created_at.desc&limit=200`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/faq_entries?order=sort_order.asc`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/support_messages?order=created_at.desc&limit=200`, { headers }),
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
    const reports = reportsResp.ok ? await reportsResp.json() : [];
    const faq = faqResp.ok ? await faqResp.json() : [];
    const support = supportResp.ok ? await supportResp.json() : [];

    return res.status(200).json({ properties, waitlist, payments, events, errors, escrow, reports, faq, support });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
