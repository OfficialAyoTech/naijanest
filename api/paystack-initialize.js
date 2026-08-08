import { authenticateUser } from '../lib/auth.js';

// Starts a Paystack payment — either to feature a listing, or to fund the
// rent/agency/legal/caution escrow for a tenancy. The client never talks to
// Paystack directly — everything (amount, ownership check) is decided server-side.
const FEATURED_PRICE_KOBO = 500000; // ₦5,000 — change this one constant to adjust pricing
const FEATURED_DAYS = 30;
const CONFIRM_WINDOW_DAYS = 7; // renter has this long to confirm move-in before auto-release

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { property_id, access_token, purpose, whatsapp_number } = req.body || {};
    if (!property_id || !access_token) {
      return res.status(400).json({ error: 'Missing property_id or access_token' });
    }

    const user = await authenticateUser(access_token);
    if (!user) return res.status(401).json({ error: 'Please sign in again' });

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (purpose === 'rent_escrow') {
      return await initializeRentEscrow({ req, res, user, property_id, serviceKey, whatsapp_number });
    }
    return await initializeFeaturedListing({ req, res, user, property_id, serviceKey });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ---- Existing flow: pay ₦5,000 to feature a listing ------------------------
async function initializeFeaturedListing({ req, res, user, property_id, serviceKey }) {
  // Confirm this property actually belongs to this user (service role bypasses RLS —
  // so we must check ownership ourselves rather than relying on the query being pre-scoped)
  const propResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${property_id}&select=id,user_id,status,name`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const props = await propResp.json();
  const property = props[0];
  if (!property || property.user_id !== user.id) {
    return res.status(403).json({ error: 'You can only feature your own listings' });
  }
  if (property.status !== 'approved') {
    return res.status(400).json({ error: 'Only live listings can be featured' });
  }

  const reference = `naijanest_${property_id}_${Date.now()}`;
  const origin = req.headers.origin || `https://${req.headers.host}`;

  const initResp = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email || `${user.id}@naijanest.user`,
      amount: FEATURED_PRICE_KOBO,
      reference,
      callback_url: `${origin}/my-listings.html`,
      metadata: { property_id, user_id: user.id, purpose: 'featured_listing' },
    }),
  });
  const initData = await initResp.json();
  if (!initData.status) {
    return res.status(400).json({ error: initData.message || 'Could not start payment' });
  }

  // Log a pending payment row so the webhook/verify step has something to reconcile against
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/payments`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      property_id, user_id: user.id, reference,
      amount: FEATURED_PRICE_KOBO, status: 'pending',
    }),
  });

  return res.status(200).json({
    authorization_url: initData.data.authorization_url,
    reference,
  });
}

// ---- New flow: fund the rent/agency/legal/caution escrow for a tenancy -----
async function initializeRentEscrow({ req, res, user, property_id, serviceKey, whatsapp_number }) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  // Renters have no phone number anywhere else in the system (Google/email
  // sign-in only) — collected once here so escrow notifications have
  // somewhere to go. Best-effort: a missing/invalid number never blocks
  // the actual payment, it just means no WhatsApp updates for this renter.
  if (whatsapp_number) {
    const digits = String(whatsapp_number).replace(/\D/g, '');
    if (digits.length >= 10) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ whatsapp_number: digits }),
      });
    }
  }

  const propResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${property_id}` +
    `&select=id,user_id,status,name,price,agency_fee_percent,legal_fee_percent,caution_fee`,
    { headers }
  );
  const props = await propResp.json();
  const property = props[0];
  if (!property) return res.status(404).json({ error: 'Listing not found' });
  if (property.status !== 'approved') {
    return res.status(400).json({ error: 'This listing is not currently available' });
  }
  if (property.user_id === user.id) {
    return res.status(400).json({ error: "You can't pay rent on your own listing" });
  }

  // The landlord must have payout details on file before we accept money on
  // their behalf — otherwise there's no way to release it to them later.
  const landlordResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${property.user_id}` +
    `&select=id,bank_account_number,paystack_recipient_code`,
    { headers }
  );
  const landlords = await landlordResp.json();
  const landlord = landlords[0];
  if (!landlord || !landlord.bank_account_number) {
    return res.status(400).json({
      error: 'This landlord has not set up payouts yet. Please check back soon or contact them via WhatsApp.',
    });
  }

  const price = Number(property.price) || 0;
  const agencyFeePercent = Number(property.agency_fee_percent) || 0;
  const legalFeePercent = Number(property.legal_fee_percent) || 0;
  const cautionFee = Number(property.caution_fee) || 0;

  // All amounts in kobo (Paystack's base unit) from here on.
  const rentAmount = Math.round(price * 100);
  const agencyFeeAmount = Math.round(price * (agencyFeePercent / 100) * 100);
  const legalFeeAmount = Math.round(price * (legalFeePercent / 100) * 100);
  const cautionFeeAmount = Math.round(cautionFee * 100);
  const totalAmount = rentAmount + agencyFeeAmount + legalFeeAmount + cautionFeeAmount;

  if (totalAmount <= 0) {
    return res.status(400).json({ error: 'This listing does not have a valid price set' });
  }

  const reference = `naijanest_escrow_${property_id}_${Date.now()}`;
  const origin = req.headers.origin || `https://${req.headers.host}`;

  const initResp = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email || `${user.id}@naijanest.user`,
      amount: totalAmount,
      reference,
      callback_url: `${origin}/my-listings.html?escrow_ref=${reference}`,
      metadata: {
        property_id, renter_id: user.id, landlord_id: property.user_id,
        purpose: 'rent_escrow',
      },
    }),
  });
  const initData = await initResp.json();
  if (!initData.status) {
    return res.status(400).json({ error: initData.message || 'Could not start payment' });
  }

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      property_id, renter_id: user.id, landlord_id: property.user_id, reference,
      rent_amount: rentAmount, agency_fee_amount: agencyFeeAmount,
      legal_fee_amount: legalFeeAmount, caution_fee_amount: cautionFeeAmount,
      total_amount: totalAmount, status: 'pending_payment',
    }),
  });

  return res.status(200).json({
    authorization_url: initData.data.authorization_url,
    reference,
    breakdown: {
      rent: rentAmount / 100, agency_fee: agencyFeeAmount / 100,
      legal_fee: legalFeeAmount / 100, caution_fee: cautionFeeAmount / 100,
      total: totalAmount / 100,
    },
  });
}
