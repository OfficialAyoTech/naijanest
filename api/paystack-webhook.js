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

// Self-hosted error monitoring: logs to a Supabase table and sends a WhatsApp
// alert to the admin, at most once per 15 minutes per source, so a real problem
// gets noticed without spamming the phone on repeated/flapping errors.
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
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
  } catch (error) {
    console.error('paystack-webhook error:', error.message);
    await logError('paystack-webhook', error);
    return res.status(200).send('ok'); // still 200 so Paystack doesn't endlessly retry
  }
}
