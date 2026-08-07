const FEATURED_DAYS = 30;
const CONFIRM_WINDOW_DAYS = 7; // keep in sync with paystack-initialize.js / paystack-webhook.js

// escrow_transactions.status values:
//   pending_payment -> funded -> confirmed | disputed -> released | refunded
//   (payment_failed is a terminal dead-end from pending_payment)

// Self-hosted error monitoring: logs to a Supabase table and sends a WhatsApp
// alert to the admin, at most once per 15 minutes per source, so a real problem
// gets noticed without spamming the phone on repeated/flapping errors. Same
// pattern as paystack-webhook.js — this file moves real money (transfers,
// refunds, the auto-release cron) and previously had zero monitoring on it.
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

async function authenticate(access_token) {
  const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) return null;
  return await userResp.json();
}

async function notifyAdminWhatsApp(message) {
  try {
    if (!process.env.ADMIN_WHATSAPP_NUMBER || !process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) return;
    const digits = String(process.env.ADMIN_WHATSAPP_NUMBER).replace(/\D/g, '');
    const e164 = digits.startsWith('234') ? digits : digits.startsWith('0') ? '234' + digits.slice(1) : digits;
    await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: e164, type: 'text', text: { body: message } }),
    });
  } catch (e) {
    console.error('notifyAdminWhatsApp failed:', e.message);
  }
}

// Pays the rent portion out to the landlord via Paystack Transfers, creating
// a transfer recipient first if this landlord doesn't have one yet. Agency
// and legal fees are NOT transferred — they stay in the platform's Paystack
// balance. The caution fee is also NOT transferred — it stays held (refund
// logic is future work, see caution_fee_status on the row).
async function releaseEscrow({ escrow, headers }) {
  if (!['funded', 'confirmed'].includes(escrow.status)) {
    return { skipped: true }; // already released/disputed/refunded — idempotent
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

  return { released: true };
}

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

// Runs once/day via Vercel Cron (see vercel.json). Releases two kinds of row:
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

  return res.status(200).json({ swept: due.length, results });
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
  const user = await authenticate(access_token);
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
  const user = await authenticate(access_token);
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
  const user = await authenticate(access_token);
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
  const user = await authenticate(access_token);
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
