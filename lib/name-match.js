// Fuzzy matching between a listing's landlord_name (typed on the form) and
// the account_name Paystack returns when resolving a bank account (i.e. the
// name on the actual bank record, from bank/resolve). These are two
// independently-sourced strings for what should be the same person, so an
// exact-string compare is far too strict: bank records are often "SURNAME
// FIRSTNAME MIDDLENAME" in caps, form entries are "Firstname Surname", and
// either side may include/omit a middle name or an honorific. This is a
// deliberately lenient token-overlap check — it exists to flag listings for
// a human to double-check, not to silently block a real landlord.

const TITLES = new Set([
  'mr', 'mrs', 'miss', 'ms', 'mstr', 'dr', 'prof', 'professor', 'engr', 'engineer',
  'barr', 'barrister', 'chief', 'alhaji', 'alhaja', 'otunba', 'prince', 'princess',
  'pastor', 'rev', 'reverend', 'hon', 'honourable', 'honorable', 'elder', 'deacon',
  'deaconess', 'comrade',
]);

export function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !TITLES.has(t) && t.length >= 2);
}

// Small Levenshtein distance — only used to tolerate a single-character typo
// (transposition, missing/extra letter) on longer tokens, e.g. "chukwuemeka"
// vs "chukwuemka".
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function tokensMatch(a, b) {
  if (a === b) return true;
  // Typo tolerance only kicks in for longer tokens. Short Nigerian first
  // names cluster tightly (Femi/Kemi/Yemi/Remi, Tayo/Kayo/Dayo/Bayo) — a
  // 1-edit allowance down at 4-5 letters would treat plainly different
  // people as a match, so the floor is set well above that cluster.
  if (a.length >= 6 && b.length >= 6) return levenshtein(a, b) <= 1;
  return false;
}

// Returns true when the two names are plausibly the same person, false when
// they look like different people. Errs toward "match" (true) whenever there
// isn't enough signal to say otherwise, since the cost of a missed mismatch
// is a slightly-less-useful flag, while the cost of a false mismatch is an
// admin chasing a legitimate landlord for no reason.
export function namesLikelyMatch(nameA, nameB) {
  const tokensA = normalizeName(nameA);
  const tokensB = normalizeName(nameB);
  if (!tokensA.length || !tokensB.length) return true;

  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const matched = shorter.filter((t) => longer.some((u) => tokensMatch(t, u))).length;

  // A single-token name (rare, but possible) needs its one token to actually
  // hit — otherwise at least half the shorter name's tokens need to line up,
  // which comfortably covers "2 of 2" and "2 of 3" name-order/middle-name
  // variants without being so loose it stops meaning anything.
  if (shorter.length === 1) return matched === 1;
  return matched / shorter.length >= 0.5;
}
