import { authenticateUser } from '../lib/auth.js';
import { notifyAdminWhatsApp, notifyLandlordByProperty, logError } from '../lib/notify.js';

// Saves a real inspection booking and notifies both the landlord and the
// admin. Previously confirmInspect() in index.html only rendered a success
// screen client-side — nothing was saved, and no one was ever told a
// tenant had booked a viewing.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { property_id, renter_name, renter_phone, inspection_date, time_slot, access_token } = req.body || {};
    if (!property_id || !renter_name || !renter_phone || !inspection_date || !time_slot) {
      return res.status(400).json({ error: 'Missing required booking details' });
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

    // Booking doesn't require login today (same as before this fix) — if a
    // token was sent anyway, attach the user id so a future "My Bookings"
    // view is possible without a schema change later. Best-effort only.
    let renterUserId = null;
    if (access_token) {
      try {
        const user = await authenticateUser(access_token);
        if (user) renterUserId = user.id;
      } catch (e) { /* not logged in, or token expired — booking still proceeds */ }
    }

    const propResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${property_id}&select=id,name,area,city,status`,
      { headers }
    );
    const props = await propResp.json();
    const property = props[0];
    if (!property) return res.status(404).json({ error: 'Listing not found' });

    const insertResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/inspection_bookings`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        property_id,
        renter_user_id: renterUserId,
        renter_name: String(renter_name).slice(0, 200),
        renter_phone: String(renter_phone).replace(/\D/g, '').slice(0, 20),
        inspection_date,
        time_slot: String(time_slot).slice(0, 100),
      }),
    });
    if (!insertResp.ok) {
      const err = await insertResp.text();
      await logError('book-inspection', new Error(`Insert failed: ${err}`));
      return res.status(400).json({ error: 'Could not save booking' });
    }

    const dateLabel = new Date(inspection_date).toDateString();
    const propLabel = `${property.name} — ${property.area}, ${property.city}`;

    // Best-effort — a notification hiccup should never make the booking
    // itself fail, since the row is already safely saved above.
    try {
      await notifyLandlordByProperty(property_id, headers,
        `📅 New inspection booked for "${propLabel}"\nTenant: ${renter_name}\nPhone: ${renter_phone}\nWhen: ${dateLabel}, ${time_slot}\n\nPlease reach out to confirm.`);
    } catch (e) { console.error('inspection landlord notify failed:', e.message); }

    try {
      await notifyAdminWhatsApp(
        `📅 Inspection booked\nProperty: ${propLabel}\nTenant: ${renter_name} (${renter_phone})\nWhen: ${dateLabel}, ${time_slot}`);
    } catch (e) { console.error('inspection admin notify failed:', e.message); }

    return res.status(200).json({ success: true });
  } catch (error) {
    await logError('book-inspection', error);
    return res.status(500).json({ error: error.message });
  }
}
