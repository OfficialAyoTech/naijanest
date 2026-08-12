import crypto from 'crypto';

// Short-lived signed token proving a specific phone number was confirmed via
// WhatsApp OTP a moment ago. Deliberately stateless — nothing to store or
// clean up server-side, since lib/whatsapp-otp.js already handles the
// pin/session state itself. Checked against the *same* phone number again at final
// listing-submission time, so verifying one number and submitting a
// different one on the form doesn't slip through.
const TTL_MS = 30 * 60 * 1000; // 30 minutes — long enough to finish the rest of the form

function sign(payload) {
  const secret = process.env.PHONE_OTP_SECRET;
  if (!secret) throw new Error('PHONE_OTP_SECRET is not set');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function issuePhoneVerifiedToken(phoneDigits) {
  const payload = `${phoneDigits}:${Date.now() + TTL_MS}`;
  const sig = sign(payload);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

export function checkPhoneVerifiedToken(token, phoneDigits) {
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

  const [tokenPhone, expStr] = payload.split(':');
  if (tokenPhone !== phoneDigits) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  return true;
}
