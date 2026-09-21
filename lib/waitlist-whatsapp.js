// Waitlist outreach via the approved Marketing template
// ("waitlist_launch_announcement": one body variable {{1}} = first name, plus a
// static "Open NaijaNest" URL button that needs no parameters).
//
// Lives in its own file (not notify.js) so the escrow/OTP notification path is
// untouched. Unlike notifyWhatsApp(), this returns the real reason a send
// failed so the admin dashboard can show it instead of a bare "1 failed".
import { logError } from './notify.js';

export const WAITLIST_TEMPLATE_NAME = process.env.WAITLIST_TEMPLATE_NAME || 'waitlist_launch_announcement';
// Must match the language you picked in WhatsApp Manager exactly:
// "English" = en, "English (US)" = en_US.
const WAITLIST_TEMPLATE_LANG = process.env.WAITLIST_TEMPLATE_LANG || 'en';

// 08100398125 / +234 810 039 8125 / 2348100398125 / 8100398125 -> 2348100398125
export function toE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return '234' + digits.slice(1);
  if (digits.length === 10) return '234' + digits;
  return digits;
}

// "vivian Amitor" -> "Vivian". Template params can't contain newlines/tabs.
function firstName(name) {
  const first = String(name || '').replace(/\s+/g, ' ').trim().split(' ')[0];
  if (!first) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

const ERROR_HINTS = {
  131030: "Recipient isn't on Meta's allowed list. The app is still sending from the test number. Check WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN in Vercel, then redeploy.",
  190: 'Access token expired or invalid. Use a System User permanent token in WHATSAPP_TOKEN.',
  131042: 'Payment problem on the WhatsApp Business Account. Add or fix the payment method in Meta.',
  132001: `Template not found. Check the name and language code (${WAITLIST_TEMPLATE_NAME} / ${WAITLIST_TEMPLATE_LANG}) match WhatsApp Manager exactly, and that it is Active.`,
  132000: 'Wrong number of template parameters.',
  132015: 'Template is paused or disabled by Meta. Check its status in WhatsApp Manager.',
  131026: "Message undeliverable. The number may not be on WhatsApp.",
  131049: "Meta chose not to deliver this marketing message (ecosystem engagement limit). Retrying later can work.",
  133010: "The sending phone number isn't registered. Check the Phone Number ID.",
  131047: 'Outside the 24-hour window and not sent as a template.',
};

// Returns { ok: true } or { ok: false, code, reason }. Never throws.
export async function sendWaitlistTemplate(phone, name) {
  try {
    if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
      return { ok: false, code: null, reason: 'WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set in Vercel' };
    }
    const to = toE164(phone);
    if (!to) return { ok: false, code: null, reason: 'No usable WhatsApp number' };

    const resp = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: WAITLIST_TEMPLATE_NAME,
          language: { code: WAITLIST_TEMPLATE_LANG },
          components: [{ type: 'body', parameters: [{ type: 'text', text: firstName(name) }] }],
        },
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      let code = null;
      let message = errBody.slice(0, 200);
      try {
        const parsed = JSON.parse(errBody);
        code = parsed?.error?.code ?? null;
        message = parsed?.error?.error_data?.details || parsed?.error?.message || message;
      } catch (e) { /* non-JSON error body, keep the raw text */ }

      console.error(`waitlist template send failed (${resp.status}):`, errBody);
      // skipDuplicateLog: a 20-person batch with the same underlying problem
      // shouldn't write 20 identical rows or 20 alerts.
      await logError('waitlist-whatsapp', new Error(`Waitlist template send failed (${resp.status}): ${errBody.slice(0, 500)}`), { skipDuplicateLog: true });
      return { ok: false, code, reason: `${code ? '#' + code + ': ' : ''}${ERROR_HINTS[code] || message}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('sendWaitlistTemplate failed:', e.message);
    await logError('waitlist-whatsapp', e, { skipDuplicateLog: true });
    return { ok: false, code: null, reason: `Network error: ${e.message}` };
  }
}
