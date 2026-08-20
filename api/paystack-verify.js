import { logError, notifyAdminWhatsApp, notifyRentFunded, notifyRentReleased } from '../lib/notify.js';
import { authenticateUser } from '../lib/auth.js';
import { releaseEscrow } from '../lib/escrow.js';
import { namesLikelyMatch } from '../lib/name-match.js';

const FEATURED_DAYS = 30;
// Short technical buffer only — NOT a tenant-facing "confirm move-in or wait"
// hold period. Funds auto-release this long after payment regardless of
// whether the tenant does anything, giving just enough time to catch a
// failed/reversed Paystack payment before payout. Keep in sync with the same
// constant in paystack-webhook.js / paystack-initialize.js.
const CONFIRM_WINDOW_HOURS = 2;

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

// ---- GET: verify-on-redirect (both purposes) + auto-release sweep -----
async function handleGet(req, res) {
  try {
    // Two ways to authenticate as the sweep job, since it's no longer just
    // Vercel Cron: (1) Vercel Cron sends Authorization: Bearer $CRON_SECRET
    // automatically once CRON_SECRET is set as an env var, or (2) an
    // external cron service (e.g. cron-job.org) hits this URL with
    // ?cron_secret=... appended — most free external cron tools can't set
    // custom headers, but all of them can hit a URL with a query string.
    // With a 2-hour release buffer instead of 7 days, this needs to run
    // every 15–30 min, not once/day, which is why an external cron entered
    // the picture at all.
    const authHeader = req.headers['authorization'] || '';
    const headerMatch = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    const queryMatch = !!process.env.CRON_SECRET && req.query.cron_secret === process.env.CRON_SECRET;
    const isCron = headerMatch || queryMatch;
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
      const confirmDeadline = new Date(Date.now() + CONFIRM_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
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

// Runs every 15–30 min via an external cron hitting this URL with
// ?cron_secret=... (see handleGet above) — was previously once/day via
// Vercel Cron, back when the confirm window was 7 days and a daily sweep
// was frequent enough. With a 2-hour window, a day-old sweep would leave
// funds sitting released-but-unpaid for up to ~24h, defeating the point of
// a short buffer.
//
// Note: the old "remind renter 2 days before their deadline" pass has been
// removed entirely. That made sense against a 7-day window; against a
// 2-hour window there's no meaningful lead time left to warn anyone about —
// it would just fire immediately for every funded transaction. Renters no
// longer need to actively do anything for funds to release, so there's
// nothing to remind them to do.
async function runAutoReleaseSweep(res) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  // Releases two kinds of row:
  //  1. still 'funded' past its confirm_deadline — the short buffer has
  //     elapsed with no dispute raised, so it auto-releases.
  //  2. stuck at 'confirmed' — a renter DID confirm move-in, but the release
  //     that's supposed to fire immediately on confirm failed (e.g. a
  //     transient Paystack error). Without this, a failed release had no
  //     retry path at all and would sit stuck forever — 'confirmed' rows
  //     don't carry a confirm_deadline to become overdue on, so they'd never
  //     match the first condition.
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
  const user = await authenticateUser(access_token);
  if (!user) return res.status(401).json({ error: 'Please sign in again' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const resp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions` +
    `?or=(renter_id.eq.${user.id},landlord_id.eq.${user.id})&order=created_at.desc` +
    `&select=id,property_id,renter_id,landlord_id,rent_amount,agency_fee_amount,legal_fee_amount,` +
    `caution_fee_amount,platform_fee_amount,total_amount,status,confirm_deadline,funded_at,confirmed_at,disputed_at,` +
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

  // Bank details are usually added here, on "My Listings", after a listing
  // already exists — so the submit-time cross-check in submit-property.js
  // often has nothing to compare against yet. Re-run it now against this
  // user's existing listings so a mismatch still gets caught once there's
  // actually a bank name to check it against.
  try {
    await reflagExistingListings(user.id, resolveData.data.account_name, serviceKey);
  } catch (e) {
    console.error('saveBankDetails: re-flagging existing listings failed:', e.message);
  }

  return res.status(200).json({ success: true, account_name: resolveData.data.account_name });
}

async function reflagExistingListings(userId, bankAccountName, serviceKey) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const resp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/properties?user_id=eq.${userId}&select=id,name,landlord_name,bank_name_mismatch`,
    { headers }
  );
  if (!resp.ok) return;
  const listings = await resp.json();

  const newlyFlagged = [];
  for (const listing of listings) {
    const mismatch = !namesLikelyMatch(listing.landlord_name, bankAccountName);
    if (mismatch === listing.bank_name_mismatch) continue; // unchanged, skip the write
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${listing.id}`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ bank_name_mismatch: mismatch, bank_account_name_snapshot: bankAccountName }),
    });
    if (mismatch) newlyFlagged.push(listing.name);
  }

  if (newlyFlagged.length) {
    await notifyAdminWhatsApp(
      `⚠️ Bank name mismatch found after payout details update:\n` +
      `Name on file with Paystack: ${bankAccountName}\n` +
      `Listing(s) with a different landlord name: ${newlyFlagged.join(', ')}\n` +
      `Worth a closer look.`
    );
  }
}

// Renter confirms they've received the keys / moved in. Releases funds to
// the landlord immediately rather than waiting for the confirm_deadline.
// Now mostly a courtesy/early-release option rather than something renters
// need to do — the 2-hour buffer will auto-release regardless — but kept
// as-is since a renter actively confirming is still a useful signal and
// lets funds move to the landlord slightly faster than the buffer alone.
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
