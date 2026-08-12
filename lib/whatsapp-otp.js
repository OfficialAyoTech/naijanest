import crypto from 'crypto';

// Landlord phone verification, delivered over WhatsApp instead of a paid SMS
// provider (Termii, etc.) — reuses the same approved "escrow_notification"
// template already live for every other WhatsApp notification (see
// lib/notify.js). No second provider, no new billing relationship.
//
// Trade-off: WhatsApp Cloud API has no built-in OTP verify service the way
// Termii does, so this file owns the pin generation and verification itself.
// Rather than persisting the pin anywhere, its hash travels back to the
// client as a short-lived signed token and is presented again at verify
// time — same stateless approach as lib/phone-verify-token.js, nothing to
// store or clean up server-side.
//
// IMPORTANT: while WHATSAPP_PHONE_NUMBER_ID is still on Meta's test tier,
// delivery only works to numbers pre-approved as test recipients in Meta's
// WhatsApp Manager. Real landlord numbers won't receive anything until
// that's upgraded to a real WhatsApp Business number — see the open item
// about registering one. Until then, either test with approved numbers only,
// or leave LANDLORD_PHONE_OTP_ENFORCE unset (see submit-property.js) so a
// failed/undeliverable code doesn't block every listing submission.

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function toE164Digits(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return '234' + digits.slice(1);
  return digits;
}

export function generatePin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); // uniform 6-digit, zero-padded
}

export async function sendWhatsAppOtp(phoneE164Digits, pin) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error('WhatsApp is not configured (WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID missing)');
  }
  const resp = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: phoneE164Digits, type: 'template',
      template: {
        name: 'escrow_notification', language: { code: 'en' },
        components: [{ type: 'body', parameters: [
          { type: 'text', text: 'there' },
          { type: 'text', text: `Your NaijaNest phone verification code is ${pin}. It expires in 10 minutes. Do not share this code with anyone.` },
        ] }],
      },
    }),
  });
  if (!resp.ok) {
    // Common cause right now: recipient isn't a pre-approved test number on
    // the current (test-tier) WhatsApp number — see the file header note.
    const errBody = await resp.text();
    throw new Error(`WhatsApp send failed (${resp.status}): ${errBody.slice(0, 300)}`);
  }
}

function sign(payload) {
  const secret = process.env.PHONE_OTP_SECRET;
  if (!secret) throw new Error('PHONE_OTP_SECRET is not set');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Issued right after sending — encodes phone + sha256(pin) + expiry, signed
// so the client can't forge or tamper with it. The client hands this back
// (along with the pin they were sent) to checkOtpSessionToken below.
export function issueOtpSessionToken(phoneDigits, pin) {
  const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
  const payload = `${phoneDigits}:${pinHash}:${Date.now() + OTP_TTL_MS}`;
  const sig = sign(payload);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

export function checkOtpSessionToken(token, phoneDigits, pin) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [encodedPayload, sig] = token.split('.');

  let payload;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  let expectedSig;
  try {
    expectedSig = sign(payload);
  } catch {
    return false;
  }

  const sigBuf = Buffer.from(sig || '');
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  const [tokenPhone, tokenPinHash, expStr] = payload.split(':');
  if (tokenPhone !== phoneDigits) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const submittedHash = crypto.createHash('sha256').update(pin).digest('hex');
  let hashBuf, submittedBuf;
  try {
    hashBuf = Buffer.from(tokenPinHash, 'hex');
    submittedBuf = Buffer.from(submittedHash, 'hex');
  } catch {
    return false;
  }
  if (hashBuf.length !== submittedBuf.length || !crypto.timingSafeEqual(hashBuf, submittedBuf)) {
    return false;
  }

  return true;
}
