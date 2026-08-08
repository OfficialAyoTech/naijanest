import { logError, notifyAdminWhatsApp, notifyRentFunded, notifyRentReleased, notifyConfirmReminder } from '../lib/notify.js';
import { authenticateUser } from '../lib/auth.js';
import { releaseEscrow } from '../lib/escrow.js';

const FEATURED_DAYS = 30;
const CONFIRM_WINDOW_DAYS = 7; // keep in sync with paystack-initialize.js / paystack-webhook.js

// escrow_transactions.status values:
//   pending_payment -> funded -> confirmed | disputed -> released | refunded
//   (payment_failed is a terminal dead-end from pending_payment)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') return handlePost(req, res);
  if (req.method === 'GET') return handleGet(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

// ---- GET: verify-on-redirect (both purposes) + daily cron auto-release -----
async function handleGet(req, res) {
  try {
    // Vercel Cron sends Authorization: Bearer $CRON_SECRET automatically once
    // CRON_SECRET is set as an env var — see vercel.json note in the handoff.
    const authHeader = req.headers['authorization'] || '';
    const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (isCron && !req.query.reference) {
      return await runAutoReleaseSweep(res);
    }

    // Bank dropdown data for the "save bank details" form. Proxied live from
    // Paystack rather than hardcoded — bank codes do change, and a wrong one
    // silently breaks a real transfer later.
    if (req.query.list_banks) {
      return await listBanks(res);
    }

    const { reference } = req.query;
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    const verifyResp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const verifyData = await verifyResp.json();
    if (!verifyData.status || !verifyData.data) {
      return res.status(400).json({ error: 'Could not verify transaction' });
    }

    const tx = verifyData.data;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    };

    if (tx.metadata?.purpose === 'rent_escrow') {
      return await verifyRentEscrow({ tx, reference, headers, res });
    }
    return await verifyFeaturedListing({ tx, reference, headers, res });
  } catch (error) {
    await logError('paystack-verify-get', error);
    return res.status(500).json({ error: error.message });
  }
}

async function listBanks(res) {
  try {
    const resp = await fetch('https://api.paystack.co/bank?country=nigeria&currency=NGN&type=nuban&perPage=100', {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const data = await resp.json();
    if (!data.status) return res.status(400).json({ error: 'Could not fetch bank list' });
    const banks = data.data
      .map(b => ({ name: b.name, code: b.code }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ banks });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function verifyFeaturedListing({ tx, reference, headers, res }) {
  if (tx.status === 'success') {
    const propertyId = tx.metadata?.property_id;
    const featuredUntil = new Date(Date.now() + FEATURED_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const payResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/payments?reference=eq.${encodeURIComponent(reference)}&select=status`,
      { headers }
    );
    const payRows = await payResp.json();
    const alreadyProcessed = payRows[0] && payRows[0].status === 'success';

    if (!alreadyProcessed && propertyId) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/payments?reference=eq.${encodeURIComponent(reference)}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ status: 'success', updated_at: new Date().toISOString() }),
      });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${propertyId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ featured: true, featured_until: featuredUntil }),
      });
    }
    return res.status(200).json({ success: true, featured_until: featuredUntil });
  } else {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/payments?reference=eq.${encodeURIComponent(reference)}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ status: 'failed', updated_at: new Date().toISOString() }),
    });
    return res.status(200).json({ success: false, error: 'Payment was not successful' });
  }
}

async function verifyRentEscrow({ tx, reference, headers, res }) {
  const escrowResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?reference=eq.${encodeURIComponent(reference)}&select=*`,
    { headers }
  );
  const rows = await escrowResp.json();
  const escrow = rows[0];
  if (!escrow) return res.status(404).json({ error: 'Escrow record not found for this reference' });

  if (tx.status === 'success') {
    if (escrow.status === 'pending_payment') {
      const confirmDeadline = new Date(Date.now() + CONFIRM_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?reference=eq.${encodeURIComponent(reference)}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ status: 'funded', funded_at: new Date().toISOString(), confirm_deadline: confirmDeadline }),
      });
      await notifyRentFunded(escrow, headers);
    }
    return res.status(200).json({ success: true, status: 'funded', escrow_id: escrow.id });
  } else {
    if (escrow.status === 'pending_payment') {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?reference=eq.${encodeURIComponent(reference)}`, {
        method: 'PATCH', headers, body: JSON.stringify({ status: 'payment_failed' }),
      });
    }
    return res.status(200).json({ success: false, error: 'Payment was not successful' });
  }
}

// Runs once/day via Vercel Cron (see vercel.json). Two passes: releases
// overdue/stuck rows (above), then nudges renters approaching their deadline
// who haven't been reminded yet — one-shot per row via reminder_sent_at, so
// this doesn't re-fire every day of the reminder window.
async function runReminderPass(headers) {
  const in2Days = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const dueResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?status=eq.funded` +
    `&reminder_sent_at=is.null&confirm_deadline=lt.${in2Days}&confirm_deadline=gt.${now}&select=*`,
    { headers }
  );
  if (!dueResp.ok) return { reminded: 0 };
  const due = await dueResp.json();

  for (const escrow of due) {
    try {
      await notifyConfirmReminder(escrow, headers);
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ reminder_sent_at: new Date().toISOString() }),
      });
    } catch (e) {
      console.error(`reminder failed for escrow ${escrow.id}:`, e.message);
      await logError('escrow-reminder', new Error(`Escrow ${escrow.id} (${escrow.reference}): ${e.message}`));
    }
  }
  return { reminded: due.length };
}

// Releases two kinds of row:
//  1. still 'funded' past its confirm_deadline — renter never actively
//     confirmed or disputed, so it auto-releases.
//  2. stuck at 'confirmed' — a renter DID confirm move-in, but the release
//     that's supposed to fire immediately on confirm failed (e.g. a
//     transient Paystack error). Without this, a failed release had no
//     retry path at all and would sit stuck forever — 'confirmed' rows
//     don't carry a confirm_deadline to become overdue on, so they'd never
//     match the first condition.
async function runAutoReleaseSweep(res) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const dueResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions` +
    `?or=(and(status.eq.funded,confirm_deadline.lt.${new Date().toISOString()}),status.eq.confirmed)` +
    `&select=*`,
    { headers }
  );
  if (!dueResp.ok) return res.status(500).json({ error: 'Could not fetch due escrow rows' });
  const due = await dueResp.json();

  const results = [];
  for (const escrow of due) {
    try {
      await releaseEscrow({ escrow, headers });
      results.push({ id: escrow.id, ok: true });
    } catch (e) {
      console.error(`auto-release failed for escrow ${escrow.id}:`, e.message);
      await logError('escrow-auto-release', new Error(`Escrow ${escrow.id} (${escrow.reference}): ${e.message}`));
      results.push({ id: escrow.id, ok: false, error: e.message });
    }
  }

  const reminderResult = await runReminderPass(headers);

  return res.status(200).json({ swept: due.length, results, ...reminderResult });
}

// ---- POST: renter/landlord actions -----------------------------------------
async function handlePost(req, res) {
  try {
    const { action } = req.body || {};
    if (action === 'save_bank_details') return await saveBankDetails(req, res);
    if (action === 'confirm_move_in') return await confirmMoveIn(req, res);
    if (action === 'raise_dispute') return await raiseDispute(req, res);
    if (action === 'my_escrow') return await myEscrow(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    await logError('paystack-verify-post', error);
    return res.status(500).json({ error: error.message });
  }
}

// escrow_transactions has RLS locked to service-role-only (see migration) —
// no one can query it straight from the browser. This is how a renter sees
// payments they've made, and a landlord sees payments they've received.
async function myEscrow(req, res) {
  const { access_token } = req.body || {};
  if (!access_token) return res.status(400).json({ error: 'Missing access_token' });
  const user = await authenticateUser(access_token);
  if (!user) return res.status(401).json({ error: 'Please sign in again' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const resp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions` +
    `?or=(renter_id.eq.${user.id},landlord_id.eq.${user.id})&order=created_at.desc` +
    `&select=id,property_id,renter_id,landlord_id,rent_amount,agency_fee_amount,legal_fee_amount,` +
    `caution_fee_amount,total_amount,status,confirm_deadline,funded_at,confirmed_at,disputed_at,` +
    `dispute_reason,released_at,refunded_at,reference,created_at`,
    { headers }
  );
  if (!resp.ok) return res.status(400).json({ error: 'Could not fetch escrow records' });
  const rows = await resp.json();
  return res.status(200).json({ escrow: rows, user_id: user.id });
}

// Landlord sets/updates payout bank details. The account number + bank code
// are verified against Paystack's own records (bank/resolve) so we always
// store the REAL account name, never whatever the landlord typed — this is
// what catches a mistyped digit before it costs someone a failed payout.
async function saveBankDetails(req, res) {
  const { access_token, bank_code, bank_name, account_number } = req.body || {};
  if (!access_token || !bank_code || !account_number) {
    return res.status(400).json({ error: 'Missing access_token, bank_code, or account_number' });
  }
  const user = await authenticateUser(access_token);
  if (!user) return res.status(401).json({ error: 'Please sign in again' });

  const digits = String(account_number).replace(/\D/g, '');
  if (digits.length !== 10) return res.status(400).json({ error: 'Account number must be 10 digits' });

  const resolveResp = await fetch(
    `https://api.paystack.co/bank/resolve?account_number=${digits}&bank_code=${encodeURIComponent(bank_code)}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );
  const resolveData = await resolveResp.json();
  if (!resolveData.status) {
    return res.status(400).json({ error: resolveData.message || 'Could not verify this account number' });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      bank_code, bank_name: bank_name || null,
      bank_account_number: digits, bank_account_name: resolveData.data.account_name,
      // Reset — any stale recipient was tied to the old bank details, and
      // releaseEscrow() will lazily create a fresh one with the new details.
      paystack_recipient_code: null,
    }),
  });

  return res.status(200).json({ success: true, account_name: resolveData.data.account_name });
}

// Renter confirms they've received the keys / moved in. Releases funds to
// the landlord immediately rather than waiting for the confirm_deadline.
async function confirmMoveIn(req, res) {
  const { escrow_id, access_token } = req.body || {};
  if (!escrow_id || !access_token) {
    return res.status(400).json({ error: 'Missing escrow_id or access_token' });
  }
  const user = await authenticateUser(access_token);
  if (!user) return res.status(401).json({ error: 'Please sign in again' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const escrowResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}&select=*`, { headers }
  );
  const rows = await escrowResp.json();
  const escrow = rows[0];
  if (!escrow) return res.status(404).json({ error: 'Escrow record not found' });
  if (escrow.renter_id !== user.id) return res.status(403).json({ error: 'Not your payment' });
  if (escrow.status !== 'funded') {
    return res.status(400).json({ error: `Cannot confirm — current status is ${escrow.status}` });
  }

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ status: 'confirmed', confirmed_at: new Date().toISOString() }),
  });

  try {
    await releaseEscrow({ escrow: { ...escrow, status: 'confirmed' }, headers });
  } catch (e) {
    console.error(`release after confirm failed for escrow ${escrow_id}:`, e.message);
    await logError('escrow-release', new Error(`Escrow ${escrow_id} (${escrow.reference}) confirmed but release failed: ${e.message}`));
    // Move-in is still confirmed — the row stays 'confirmed' and the next
    // cron sweep (or a retry) will pick it up. Don't fail the request the
    // renter is looking at just because the payout leg had a hiccup.
    return res.status(200).json({
      success: true, released: false,
      note: 'Move-in confirmed. Payout to the landlord is processing.',
    });
  }

  return res.status(200).json({ success: true, released: true });
}

// Renter disputes before confirming — freezes the row (no auto-release, no
// manual confirm) and alerts the admin to review and resolve it manually.
async function raiseDispute(req, res) {
  const { escrow_id, access_token, reason } = req.body || {};
  if (!escrow_id || !access_token || !reason) {
    return res.status(400).json({ error: 'Missing escrow_id, access_token, or reason' });
  }
  const user = await authenticateUser(access_token);
  if (!user) return res.status(401).json({ error: 'Please sign in again' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const escrowResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}&select=*`, { headers }
  );
  const rows = await escrowResp.json();
  const escrow = rows[0];
  if (!escrow) return res.status(404).json({ error: 'Escrow record not found' });
  if (escrow.renter_id !== user.id) return res.status(403).json({ error: 'Not your payment' });
  if (escrow.status !== 'funded') {
    return res.status(400).json({ error: `Cannot dispute — current status is ${escrow.status}` });
  }

  const cleanReason = String(reason).slice(0, 1000);
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow_id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ status: 'disputed', disputed_at: new Date().toISOString(), dispute_reason: cleanReason }),
  });

  await notifyAdminWhatsApp(
    `🚩 Escrow dispute raised on payment ${escrow.reference}.\nReason: ${cleanReason.slice(0, 300)}\nReview in the admin dashboard.`
  );

  return res.status(200).json({ success: true });
}
