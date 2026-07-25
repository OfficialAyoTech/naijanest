const FEATURED_DAYS = 30;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
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

    if (tx.status === 'success') {
      const propertyId = tx.metadata?.property_id;
      const featuredUntil = new Date(Date.now() + FEATURED_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Idempotent: only act if this payment hasn't already been marked success
      // (avoids double-processing if the webhook already handled it)
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
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
