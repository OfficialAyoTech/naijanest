import crypto from 'crypto';

// Vercel must not pre-parse the body — we need the exact raw bytes to verify the signature.
export const config = { api: { bodyParser: false } };

const FEATURED_DAYS = 30;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-paystack-signature'];
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (!signature || signature !== expected) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(rawBody);

  if (event.event === 'charge.success') {
    const tx = event.data;
    const propertyId = tx.metadata?.property_id;
    const reference = tx.reference;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    };

    // Idempotent — skip if verify-on-redirect already handled this reference
    const payResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/payments?reference=eq.${encodeURIComponent(reference)}&select=status`,
      { headers }
    );
    const payRows = await payResp.json();
    const alreadyProcessed = payRows[0] && payRows[0].status === 'success';

    if (!alreadyProcessed && propertyId) {
      const featuredUntil = new Date(Date.now() + FEATURED_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/payments?reference=eq.${encodeURIComponent(reference)}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ status: 'success', updated_at: new Date().toISOString() }),
      });
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${propertyId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ featured: true, featured_until: featuredUntil }),
      });
    }
  }

  return res.status(200).send('ok');
}
