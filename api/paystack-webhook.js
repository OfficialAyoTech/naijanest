import crypto from 'crypto';
import { logError, notifyRentFunded } from '../lib/notify.js';
// Vercel must not pre-parse the body — we need the exact raw bytes to verify the signature.
export const config = { api: { bodyParser: false } };
const FEATURED_DAYS = 30;
// Automatic release buffer — NOT a discretionary "we decide when to release"
// hold. Funds auto-release this long after payment regardless of whether the
// tenant does anything; it exists to give tenants a realistic window to move
// in and report a problem, and to line up with typical Paystack settlement
// timing so funds are actually transferable by the time release fires. Keep
// in sync with the same constant in paystack-verify.js / paystack-initialize.js.
const CONFIRM_WINDOW_HOURS = 24;
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function fundEscrow(tx, headers) {
  const reference = tx.reference;
  const escrowResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?reference=eq.${encodeURIComponent(reference)}&select=id,status,property_id,renter_id,total_amount`,
    { headers }
  );
  const rows = await escrowResp.json();
  const escrow = rows[0];
  if (!escrow) return; // not one of ours, or verify-on-redirect will catch it
  if (escrow.status !== 'pending_payment') return; // already funded — idempotent
  const confirmDeadline = new Date(Date.now() + CONFIRM_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?reference=eq.${encodeURIComponent(reference)}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      status: 'funded', funded_at: new Date().toISOString(), confirm_deadline: confirmDeadline,
    }),
  });
  await notifyRentFunded(escrow, headers);
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
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const headers = {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      };
      if (tx.metadata?.purpose === 'rent_escrow') {
        await fundEscrow(tx, headers);
      } else {
        const propertyId = tx.metadata?.property_id;
        const reference = tx.reference;
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
    }
    return res.status(200).send('ok');
  } catch (error) {
    console.error('paystack-webhook error:', error.message);
    await logError('paystack-webhook', error);
    return res.status(200).send('ok'); // still 200 so Paystack doesn't endlessly retry
  }
}
