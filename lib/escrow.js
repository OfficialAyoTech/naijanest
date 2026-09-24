import { logError, notifyRentReleased, notifyLandlordCustom } from './notify.js';

// ---------------------------------------------------------------------------
// Payout model. escrow_transactions.payout_mode is snapshotted from the
// listing at checkout (see paystack-initialize.js), so changing a listing
// later never changes where an already-paid escrow goes:
//
//   null (rows created before Agent Payouts)
//       rent only -> landlord_id's profile account. Unchanged legacy behaviour.
//   'self'             lister IS the landlord
//   'lister_collects'  lister acting for someone else, collecting everything
//       rent + agency fee + documentation fee -> lister's account (one Transfer)
//   'split'            lister acting for someone else, landlord paid directly
//       rent -> landlord's account (property_payout_accounts)
//       agency fee + documentation fee -> lister's profile account, as a
//       SECOND Transfer with its own status (lister_payout_status), so the
//       landlord's rent never waits on the lister's bank details.
//
// Never transferred here: the caution fee (held until settleCautionFee in
// admin-data.js) and the NaijaNest platform fee (stays in the balance).
// ---------------------------------------------------------------------------

const SUPA = () => process.env.SUPABASE_URL;
const paystackHeaders = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json',
});

// A "payee" is anything money can be sent to: a profile's bank details, or
// the landlord account stored against a split listing. Both expose the same
// shape so the transfer logic below is written once.
async function loadProfilePayee(userId, headers) {
  if (!userId) return null;
  const resp = await fetch(
    `${SUPA()}/rest/v1/profiles?id=eq.${userId}` +
    `&select=id,bank_code,bank_account_number,bank_account_name,paystack_recipient_code,` +
    `verified_via_payment,completed_transactions_count`,
    { headers }
  );
  if (!resp.ok) return null;
  const p = (await resp.json())[0];
  if (!p) return null;
  return {
    profile: p,
    bank_code: p.bank_code,
    account_number: p.bank_account_number,
    account_name: p.bank_account_name,
    recipient_code: p.paystack_recipient_code,
    async saveRecipientCode(code) {
      await fetch(`${SUPA()}/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ paystack_recipient_code: code }),
      });
    },
  };
}

async function loadPropertyPayee(propertyId, headers) {
  if (!propertyId) return null;
  const resp = await fetch(
    `${SUPA()}/rest/v1/property_payout_accounts?property_id=eq.${propertyId}&select=*`,
    { headers }
  );
  if (!resp.ok) return null;
  const a = (await resp.json())[0];
  if (!a) return null;
  return {
    bank_code: a.bank_code,
    account_number: a.account_number,
    account_name: a.account_name,
    recipient_code: a.paystack_recipient_code,
    async saveRecipientCode(code) {
      await fetch(`${SUPA()}/rest/v1/property_payout_accounts?property_id=eq.${propertyId}`, {
        method: 'PATCH', headers, body: JSON.stringify({ paystack_recipient_code: code }),
      });
    },
  };
}

// Who received (or will receive) the RENT for this escrow. Also used by
// settleCautionFee in admin-data.js so a forfeited caution fee goes to the
// same place the rent went.
export async function getRentPayee({ escrow, headers }) {
  if (escrow.payout_mode === 'split') return loadPropertyPayee(escrow.property_id, headers);
  return loadProfilePayee(escrow.landlord_id, headers);
}

// Sends `amount` (kobo) to a payee via Paystack Transfers, creating the
// transfer recipient first if needed. A cached recipient_code can go stale —
// most commonly because it was created under a different Paystack secret key
// (test vs live: recipient codes are environment-specific). Paystack reports
// that as "Recipient specified is invalid", so on that specific failure the
// recipient is recreated under the active key and the transfer retried once.
//
// Errors thrown here that mean "Paystack definitely rejected this" are tagged
// paystackRejected = true (no money moved). Anything else (e.g. a network
// error mid-request) is ambiguous — callers must not assume no transfer went
// out. insufficientBalance is the normal, self-resolving Paystack balance hold.
export async function transferToPayee({ payee, amount, refBase, reason }) {
  async function createRecipient() {
    const recResp = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST',
      headers: paystackHeaders(),
      body: JSON.stringify({
        type: 'nuban', name: payee.account_name,
        account_number: payee.account_number, bank_code: payee.bank_code,
        currency: 'NGN',
      }),
    });
    const recData = await recResp.json();
    if (!recData.status) {
      const err = new Error(`Could not create Paystack recipient: ${recData.message}`);
      err.paystackRejected = true;
      throw err;
    }
    const code = recData.data.recipient_code;
    await payee.saveRecipientCode(code);
    return code;
  }

  async function attempt(recipient) {
    const transferRef = `${refBase}_${Date.now()}`;
    const transferResp = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: paystackHeaders(),
      body: JSON.stringify({ source: 'balance', amount, recipient, reference: transferRef, reason }),
    });
    return { transferData: await transferResp.json(), transferRef };
  }

  let recipientCode = payee.recipient_code || await createRecipient();
  let { transferData, transferRef } = await attempt(recipientCode);

  if (!transferData.status && /recipient/i.test(transferData.message || '')) {
    console.error(`transferToPayee: cached recipient ${recipientCode} rejected (${transferData.message}) — recreating and retrying once`);
    recipientCode = await createRecipient();
    ({ transferData, transferRef } = await attempt(recipientCode));
  }

  if (!transferData.status) {
    const err = new Error(`Transfer failed: ${transferData.message}`);
    err.paystackRejected = true;
    // Paystack holds newly-collected funds before they count toward the
    // available balance a Transfer can draw from — expected, not a bug.
    if (/balance is not enough/i.test(transferData.message || '')) err.insufficientBalance = true;
    throw err;
  }
  return { transferRef, transferCode: transferData.data.transfer_code };
}

// Pays the landlord's share out. Marks the escrow 'released' once that
// Transfer succeeds — exactly as before. For 'split' listings it then attempts
// the lister's fee payout as an independent, best-effort second step; if that
// can't go out yet (no bank details, balance hold) the cron sweep retries it
// via runListerPayoutSweep below.
export async function releaseEscrow({ escrow, headers }) {
  if (!['funded', 'confirmed', 'disputed'].includes(escrow.status)) {
    return { skipped: true }; // already released/refunded — idempotent
  }

  const mode = escrow.payout_mode || null;
  const payee = await getRentPayee({ escrow, headers });
  if (!payee || !payee.account_number) {
    // Expected/recoverable, not a code bug — the recipient just hasn't added
    // payout details yet. Tagged so the auto-release cron can alert once and
    // then go quiet on repeat sweeps for the SAME escrow.
    const err = new Error(
      mode === 'split'
        ? `Property ${escrow.property_id} has no landlord payout account on file`
        : `Landlord ${escrow.landlord_id} has no bank details on file`
    );
    err.noBankDetails = true;
    throw err;
  }

  const feesInMain = mode === 'self' || mode === 'lister_collects';
  const mainAmount = (escrow.rent_amount || 0) +
    (feesInMain ? (escrow.agency_fee_amount || 0) + (escrow.legal_fee_amount || 0) : 0);

  const { transferRef, transferCode } = await transferToPayee({
    payee, amount: mainAmount,
    refBase: `naijanest_payout_${escrow.id}`,
    reason: `NaijaNest rent payout — escrow ${escrow.id}`,
  });

  await fetch(`${SUPA()}/rest/v1/escrow_transactions?id=eq.${escrow.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      status: 'released', released_at: new Date().toISOString(),
      transfer_reference: transferRef, transfer_code: transferCode,
    }),
  });

  // Rent reached its recipient — this place is occupied, so pull it off the
  // marketplace. Best-effort: money has already moved, so log rather than throw.
  try {
    await fetch(`${SUPA()}/rest/v1/properties?id=eq.${escrow.property_id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'rented' }),
    });
  } catch (e) {
    console.error(`failed to mark property ${escrow.property_id} as rented:`, e.message);
    await logError('escrow-mark-rented', new Error(`Escrow ${escrow.id}, property ${escrow.property_id}: ${e.message}`));
  }

  // A completed release is the anchor for the verified-payment badge. It is
  // always the LISTER's profile that gets credited (landlord_id is the
  // submitting user), even on split listings where the rent went elsewhere.
  // Best-effort and idempotent-ish: never undo a payout that already went out.
  try {
    const listerPayee = mode === 'split' ? await loadProfilePayee(escrow.landlord_id, headers) : payee;
    const lister = listerPayee && listerPayee.profile;
    if (lister) {
      await fetch(`${SUPA()}/rest/v1/profiles?id=eq.${escrow.landlord_id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({
          verified_via_payment: true,
          completed_transactions_count: (lister.completed_transactions_count || 0) + 1,
        }),
      });
    }
  } catch (e) {
    console.error(`failed to update verified_via_payment for ${escrow.landlord_id}:`, e.message);
    await logError('escrow-verify-landlord', new Error(`Escrow ${escrow.id}, landlord ${escrow.landlord_id}: ${e.message}`));
  }

  await notifyRentReleased(escrow, headers);

  // Second leg (split listings only). Never allowed to fail the release.
  try {
    await releaseListerPayout({ escrow, headers });
  } catch (e) {
    if (!e.insufficientBalance) {
      console.error(`lister payout failed for escrow ${escrow.id}:`, e.message);
      await logError('escrow-lister-payout', new Error(`Escrow ${escrow.id} (${escrow.reference}): ${e.message}`));
    }
  }

  return { released: true };
}

// Pays the lister's agency + documentation fees for a 'split' escrow.
// Safe against double-paying: the row is atomically claimed (pending ->
// processing) before any money moves, so two overlapping sweeps can't both
// send it. It is only reverted to 'pending' when Paystack definitely
// rejected the Transfer; an ambiguous failure leaves it 'processing' so a
// human checks it instead of it being retried blind.
export async function releaseListerPayout({ escrow, headers }) {
  const amount = Number(escrow.lister_payout_amount) || 0;
  if (amount <= 0 || !['pending', 'pending_recipient'].includes(escrow.lister_payout_status)) {
    return { skipped: true };
  }
  const amountLabel = (amount / 100).toLocaleString();

  const payee = await loadProfilePayee(escrow.lister_id, headers);
  if (!payee || !payee.account_number) {
    // Waiting on the lister to add bank details. Flag it and tell them once;
    // the sweep keeps retrying quietly and pays out as soon as they do.
    if (escrow.lister_payout_status === 'pending') {
      await fetch(`${SUPA()}/rest/v1/escrow_transactions?id=eq.${escrow.id}&lister_payout_status=eq.pending`, {
        method: 'PATCH', headers, body: JSON.stringify({ lister_payout_status: 'pending_recipient' }),
      });
      try {
        await notifyLandlordCustom(
          escrow, headers,
          `You have ₦${amountLabel} in agency/documentation fees waiting from a completed rent payment. ` +
          `Add your bank details under My Listings → Payout Details and it will be paid out automatically.`
        );
      } catch (e) { console.error('lister payout notice failed:', e.message); }
    }
    return { waiting: true };
  }

  const claimResp = await fetch(
    `${SUPA()}/rest/v1/escrow_transactions?id=eq.${escrow.id}&lister_payout_status=in.(pending,pending_recipient)`,
    {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ lister_payout_status: 'processing' }),
    }
  );
  const claimed = claimResp.ok ? await claimResp.json() : [];
  if (!claimed.length) return { skipped: true }; // someone else has it

  let result;
  try {
    result = await transferToPayee({
      payee, amount,
      refBase: `naijanest_lister_${escrow.id}`,
      reason: `NaijaNest agent fees payout — escrow ${escrow.id}`,
    });
  } catch (e) {
    if (e.paystackRejected) {
      await fetch(`${SUPA()}/rest/v1/escrow_transactions?id=eq.${escrow.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ lister_payout_status: 'pending' }),
      });
    }
    throw e;
  }

  await fetch(`${SUPA()}/rest/v1/escrow_transactions?id=eq.${escrow.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      lister_payout_status: 'paid', lister_paid_at: new Date().toISOString(),
      lister_transfer_reference: result.transferRef, lister_transfer_code: result.transferCode,
    }),
  });
  try {
    await notifyLandlordCustom(escrow, headers, `Your agency/documentation fees of ₦${amountLabel} have been paid out to your bank account.`);
  } catch (e) { console.error('lister payout paid-notice failed:', e.message); }
  return { paid: true };
}

// Called from the 15-minute cron (runAutoReleaseSweep in paystack-verify.js).
// Retries lister payouts that couldn't go out at release time, and surfaces
// any stuck in 'processing' (an ambiguous failure — needs a human to check
// Paystack before anything is retried).
export async function runListerPayoutSweep({ headers }) {
  const summary = { paid: 0, waiting: 0, deferred: 0, failed: 0, stuck: 0 };

  const resp = await fetch(
    `${SUPA()}/rest/v1/escrow_transactions?status=eq.released` +
    `&lister_payout_status=in.(pending,pending_recipient)&select=*`,
    { headers }
  );
  const rows = resp.ok ? await resp.json() : [];
  for (const row of rows) {
    try {
      const r = await releaseListerPayout({ escrow: row, headers });
      if (r.waiting) summary.waiting++;
      else if (r.paid) summary.paid++;
    } catch (e) {
      if (e.insufficientBalance) { summary.deferred++; continue; }
      summary.failed++;
      await logError(`escrow-lister-payout:${row.id}`, new Error(`Escrow ${row.id} (${row.reference}): ${e.message}`),
        { windowMinutes: 24 * 60, skipDuplicateLog: true });
    }
  }

  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stuckResp = await fetch(
    `${SUPA()}/rest/v1/escrow_transactions?status=eq.released&lister_payout_status=eq.processing` +
    `&released_at=lt.${cutoff}&select=id,reference`,
    { headers }
  );
  const stuck = stuckResp.ok ? await stuckResp.json() : [];
  for (const row of stuck) {
    summary.stuck++;
    await logError(`escrow-lister-stuck:${row.id}`,
      new Error(`Escrow ${row.id} (${row.reference}): lister payout stuck in 'processing' — check Paystack transfers for reference naijanest_lister_${row.id}_*, then set lister_payout_status to 'paid' or back to 'pending'`),
      { windowMinutes: 24 * 60, skipDuplicateLog: true });
  }
  return summary;
}
