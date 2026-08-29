import { logError, notifyRentReleased } from './notify.js';

// Pays the rent portion out to the landlord via Paystack Transfers, creating
// a transfer recipient first if this landlord doesn't have one yet. Agency
// and legal fees are NOT transferred — they stay in the platform's Paystack
// balance. The caution fee is also NOT transferred — it stays held until
// settled separately (see settleCautionFee in admin-data.js).
//
// This used to be two near-identical copies — one in paystack-verify.js
// (called from confirm-move-in and the daily cron), one in admin-data.js
// (called when an admin resolves a dispute via "release"). The only real
// difference between them was which escrow statuses were allowed to start a
// release from — admin-data.js's copy also allowed 'disputed', since that's
// the one path that releases a disputed row. That's not a meaningful reason
// to keep two copies: this version allows all three, since nothing calls it
// on a 'disputed' row except the one context where that's actually correct.
export async function releaseEscrow({ escrow, headers }) {
  if (!['funded', 'confirmed', 'disputed'].includes(escrow.status)) {
    return { skipped: true }; // already released/refunded — idempotent
  }

  const landlordResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.landlord_id}` +
    `&select=id,bank_code,bank_account_number,bank_account_name,paystack_recipient_code,` +
    `verified_via_payment,completed_transactions_count`,
    { headers }
  );
  const landlords = await landlordResp.json();
  const landlord = landlords[0];
  if (!landlord || !landlord.bank_account_number) {
    throw new Error(`Landlord ${escrow.landlord_id} has no bank details on file`);
  }

  // Factored out so it can be called again below if a cached recipient turns
  // out to be stale — always writes the fresh code back to profiles so
  // future releases for this landlord reuse it instead of recreating every
  // time.
  async function createRecipient() {
    const recResp = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'nuban', name: landlord.bank_account_name,
        account_number: landlord.bank_account_number, bank_code: landlord.bank_code,
        currency: 'NGN',
      }),
    });
    const recData = await recResp.json();
    if (!recData.status) throw new Error(`Could not create Paystack recipient: ${recData.message}`);
    const code = recData.data.recipient_code;
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.landlord_id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ paystack_recipient_code: code }),
    });
    return code;
  }

  let recipientCode = landlord.paystack_recipient_code;
  if (!recipientCode) {
    recipientCode = await createRecipient();
  }

  async function attemptTransfer(recipient) {
    const transferRef = `naijanest_payout_${escrow.id}_${Date.now()}`;
    const transferResp = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'balance', amount: escrow.rent_amount, recipient,
        reference: transferRef, reason: `NaijaNest rent payout — escrow ${escrow.id}`,
      }),
    });
    const transferData = await transferResp.json();
    return { transferData, transferRef };
  }

  let { transferData, transferRef } = await attemptTransfer(recipientCode);

  // A cached recipient_code can go stale — most commonly because it was
  // created under a different Paystack secret key (e.g. a test-mode key,
  // before this account switched to live payouts: recipient codes are
  // environment-specific, so a recipient created under the test key simply
  // doesn't exist to the live key, and vice versa). Paystack surfaces this
  // as "Recipient specified is invalid" rather than a clearer "not found".
  // On that specific failure, recreate the recipient fresh under whichever
  // key is active right now and retry once, instead of leaving the payout
  // permanently stuck on a dead code — self-healing rather than requiring
  // manual DB intervention every time this happens.
  if (!transferData.status && /recipient/i.test(transferData.message || '')) {
    console.error(`releaseEscrow: cached recipient ${recipientCode} rejected (${transferData.message}) — recreating and retrying once`);
    recipientCode = await createRecipient();
    ({ transferData, transferRef } = await attemptTransfer(recipientCode));
  }

  if (!transferData.status) {
    const err = new Error(`Transfer failed: ${transferData.message}`);
    // Paystack holds newly-collected funds before they count toward the
    // available balance a Transfer can draw from — this is normal and
    // expected, not a bug, and will clear on its own once the hold lifts.
    // Tagging it lets callers (confirmMoveIn, runAutoReleaseSweep) skip the
    // logError/admin-WhatsApp noise for this specific expected case, while
    // still treating every other transfer failure as a real problem to
    // surface. Matches Paystack's exact current wording; if Paystack ever
    // changes this message, retries will just fall back to being logged
    // normally again rather than silently going unnoticed.
    if (/balance is not enough/i.test(transferData.message || '')) {
      err.insufficientBalance = true;
    }
    throw err;
  }

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/escrow_transactions?id=eq.${escrow.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      status: 'released', released_at: new Date().toISOString(),
      transfer_reference: transferRef, transfer_code: transferData.data.transfer_code,
    }),
  });

  // Rent actually reached the landlord — this place is occupied now, so pull
  // it off the public marketplace automatically rather than relying on the
  // admin to remember to click "Mark as Rented". Best-effort: if this fails,
  // the release itself already succeeded and money has moved, so we log
  // rather than throw.
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?id=eq.${escrow.property_id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'rented' }),
    });
  } catch (e) {
    console.error(`failed to mark property ${escrow.property_id} as rented:`, e.message);
    await logError('escrow-mark-rented', new Error(`Escrow ${escrow.id}, property ${escrow.property_id}: ${e.message}`));
  }

  // A completed release is the definitive signal that this landlord has
  // gone through a full on-platform payment cycle — money left a tenant's
  // account and landed in theirs via NaijaNest, not just "escrow was
  // funded" (which a chargeback or dispute could still unwind). This is
  // the anchor point for verified-badge eligibility and any future
  // payment-gated features. Best-effort and idempotent: flips the flag on
  // once and increments a running count, but a failure here must never
  // undo a payout that's already gone through, so we log rather than throw.
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${escrow.landlord_id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({
        verified_via_payment: true,
        completed_transactions_count: (landlord.completed_transactions_count || 0) + 1,
      }),
    });
  } catch (e) {
    console.error(`failed to update verified_via_payment for landlord ${escrow.landlord_id}:`, e.message);
    await logError('escrow-verify-landlord', new Error(`Escrow ${escrow.id}, landlord ${escrow.landlord_id}: ${e.message}`));
  }

  await notifyRentReleased(escrow, headers);

  return { released: true };
}
