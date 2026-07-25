// Starts a Paystack payment to feature a listing. The client never talks to
// Paystack directly — everything (amount, ownership check) is decided server-side.
const FEATURED_PRICE_KOBO = 500000; // ₦5,000 — change this one constant to adjust pricing
const FEATURED_DAYS = 30;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { property_id, access_token } = req.body || {};
    if (!property_id || !access_token) {
      return res.status(400).json({ error: 'Missing property_id or access_token' });
    }

    // Verify identity server-side
    const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
    });
    if (!userResp.ok) return res.status(401).json({ error: 'Please sign in again' });
    const user = await userResp.json();

    // Confirm this property actually belongs to this user (service role bypasses RLS —
    // so we must check ownership ourselves rather than relying on the query being pre-scoped)
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
