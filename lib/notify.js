// Shared notification logic. This file exists because logError and
// notifyWhatsApp were byte-for-byte identical across paystack-webhook.js,
// paystack-verify.js, and admin-data.js — and the escrow-specific senders
// (notifyRentFunded, notifyRentReleased, etc.) were duplicated across two of
// those three. Files in /lib don't count against Vercel's serverless
// function limit (only /api does), so this costs nothing to have.

// Self-hosted error monitoring: logs to the error_logs table and sends a
// WhatsApp alert to the admin, at most once per 15 minutes per source, so a
// real problem gets noticed without spamming the phone on repeated/flapping
// errors.
export async function logError(source, error) {
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

// Freeform text to the admin's own number — used for things you need to see
// right away (disputes). Different from notifyWhatsApp below, which sends a
// pre-approved template to a user (freeform text only works within
// WhatsApp's 24h reply window, which the admin number is generally within
// since it's your own number).
export async function notifyAdminWhatsApp(message) {
  try {
    if (!process.env.ADMIN_WHATSAPP_NUMBER || !process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
      console.error('notifyAdminWhatsApp: missing ADMIN_WHATSAPP_NUMBER/WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID env var(s) — message not sent');
      return;
    }
    const digits = String(process.env.ADMIN_WHATSAPP_NUMBER).replace(/\D/g, '');
    const e164 = digits.startsWith('234') ? digits : digits.startsWith('0') ? '234' + digits.slice(1) : digits;
    const resp = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: e164, type: 'text', text: { body: message } }),
    });
    if (!resp.ok) {
      // This used to fail completely silently — no log, no alert, nothing.
      // A common real cause: your WhatsApp number is still on Meta's
      // temporary test tier, which only delivers to pre-approved test
      // recipients — if ADMIN_WHATSAPP_NUMBER isn't one of those, every
      // send gets rejected here with zero visibility until now.
      const errBody = await resp.text();
      console.error(`notifyAdminWhatsApp: WhatsApp API rejected the message (${resp.status}):`, errBody);
      await logError('notify-admin-whatsapp', new Error(`WhatsApp send failed (${resp.status}): ${errBody.slice(0, 500)}`));
    }
  } catch (e) {
    console.error('notifyAdminWhatsApp failed:', e.message);
    await logError('notify-admin-whatsapp', e);
  }
}

// One generic pre-approved template ("escrow_notification", 2 body params:
// name, message) rather than one template per event — far less to get
// approved in Meta's WhatsApp Manager. Code below decides the actual wording
// per event. Best-effort — never throws, so a notification hiccup never
// blocks the money-moving action that triggered it.
//
// Returns true/false to indicate whether the send actually succeeded — added
// so callers that fire off many of these in a row (e.g. bulk waitlist
// outreach from the admin dashboard) can report an accurate per-recipient
// success/failure count instead of assuming everything went through.
// Existing single-recipient callers (notifyRentFunded, notifyRentReleased,
// etc.) don't use the return value, so this is a safe, non-breaking addition.
// WhatsApp template parameters reject newline/tab characters and 4+
// consecutive spaces outright (error code 132018) — several of the messages
// built elsewhere in this file use \n for readability in what's basically
// a single-line chat bubble, which trips this. Collapsing all whitespace
// runs (including newlines) down to a single space keeps the message
// readable while staying inside what Meta's template params accept.
function sanitizeTemplateParam(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export async function notifyWhatsApp(phone, name, message) {
  try {
    if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) return false;
    if (!phone) return false;
    const digits = String(phone).replace(/\D/g, '');
    const e164 = digits.startsWith('234') ? digits : digits.startsWith('0') ? '234' + digits.slice(1) : digits;
    const resp = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: e164, type: 'template',
        template: {
          name: 'escrow_notification', language: { code: 'en' },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: sanitizeTemplateParam(name || 'there') },
            { type: 'text', text: sanitizeTemplateParam(message) },
          ] }],
        },
      }),
    });
    if (!resp.ok) {
      // Same silent-failure blind spot as notifyAdminWhatsApp — common causes:
      // template not yet approved by Meta, or recipient not reachable on the
      // current (test-tier) WhatsApp number.
      const errBody = await resp.text();
      console.error(`notifyWhatsApp: WhatsApp API rejected the message (${resp.status}):`, errBody);
      await logError('notify-whatsapp', new Error(`WhatsApp send to user failed (${resp.status}): ${errBody.slice(0, 500)}`));
      return false;
    }
    return true;
  } catch (e) {
    console.error('notifyWhatsApp failed:', e.message);
    await logError('notify-whatsapp', e);
    return false;
  }
}

export async function notifyRentFunded(escrow, headers) {
  try {
    const [propResp, renterResp] = await Promise.all([
      fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${escrow.property_id}&select=name`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.renter_id}&select=name,whatsapp_number`, { headers }),
    ]);
    const props = await propResp.json();
    const renters = await renterResp.json();
    const property = props[0];
    const renter = renters[0];
    if (!renter?.whatsapp_number) return;

    const amount = (escrow.total_amount / 100).toLocaleString();
    await notifyWhatsApp(renter.whatsapp_number, renter.name,
      `Your payment of ₦${amount} for "${property?.name || 'your rental'}" is confirmed and held securely in escrow. Once you've received the keys, open My Listings on NaijaNest to confirm move-in.`);
  } catch (e) {
    console.error('notifyRentFunded failed:', e.message);
  }
}

export async function notifyRentReleased(escrow, headers) {
  try {
    const propResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${escrow.property_id}&select=name,landlord_name,landlord_phone`,
      { headers }
    );
    const props = await propResp.json();
    const property = props[0];
    if (!property?.landlord_phone) return;

    const amount = (escrow.rent_amount / 100).toLocaleString();
    await notifyWhatsApp(property.landlord_phone, property.landlord_name,
      `Rent payment of ₦${amount} for "${property.name}" has been released to your account. Thank you for using NaijaNest!`);
  } catch (e) {
    console.error('notifyRentReleased failed:', e.message);
  }
}

export async function notifyRenter(escrow, headers, message) {
  try {
    const renterResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.renter_id}&select=name,whatsapp_number`, { headers }
    );
    const renters = await renterResp.json();
    const renter = renters[0];
    if (!renter?.whatsapp_number) return;
    await notifyWhatsApp(renter.whatsapp_number, renter.name, message);
  } catch (e) {
    console.error('notifyRenter failed:', e.message);
  }
}

export async function notifyLandlordCustom(escrow, headers, message) {
  try {
    const propResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${escrow.property_id}&select=name,landlord_name,landlord_phone`, { headers }
    );
    const props = await propResp.json();
    const property = props[0];
    if (!property?.landlord_phone) return;
    await notifyWhatsApp(property.landlord_phone, property.landlord_name, message);
  } catch (e) {
    console.error('notifyLandlordCustom failed:', e.message);
  }
}

export async function notifyConfirmReminder(escrow, headers) {
  try {
    const [propResp, renterResp] = await Promise.all([
      fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${escrow.property_id}&select=name`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.renter_id}&select=name,whatsapp_number`, { headers }),
    ]);
    const props = await propResp.json();
    const renters = await renterResp.json();
    const property = props[0];
    const renter = renters[0];
    if (!renter?.whatsapp_number) return;

    const daysLeft = Math.max(0, Math.ceil((new Date(escrow.confirm_deadline) - new Date()) / (24 * 60 * 60 * 1000)));
    await notifyWhatsApp(renter.whatsapp_number, renter.name,
      `Reminder: your payment for "${property?.name || 'your rental'}" auto-releases to the landlord in ${daysLeft} day${daysLeft === 1 ? '' : 's'} unless you confirm move-in or report a problem on NaijaNest.`);
  } catch (e) {
    console.error('notifyConfirmReminder failed:', e.message);
  }
}

// notifyLandlordCustom above requires an escrow row (it looks up the property
// via escrow.property_id). Inspection bookings aren't tied to a payment at
// all, so this is the same idea — fetch the property, message the landlord —
// without needing an escrow object to hang it off of.
export async function notifyLandlordByProperty(propertyId, headers, message) {
  try {
    const propResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${propertyId}&select=name,landlord_name,landlord_phone`,
      { headers }
    );
    const props = await propResp.json();
    const property = props[0];
    if (!property?.landlord_phone) return;
    await notifyWhatsApp(property.landlord_phone, property.landlord_name, message);
  } catch (e) {
    console.error('notifyLandlordByProperty failed:', e.message);
  }
}
