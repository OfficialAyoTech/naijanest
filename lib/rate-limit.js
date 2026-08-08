// Shared rate-limit table (rate_limit_events: key, created_at). Returns true
// if this key has already hit maxRequests within windowMinutes.
//
// This exact function already exists independently in chat.js and
// whatsapp-webhook.js (pre-dating tonight's /lib cleanup). Not touching
// those two right now — out of scope for what was actually asked — but new
// usages (like report_listing below) should import this rather than adding
// a third copy.
export async function isRateLimited(key, maxRequests, windowMinutes, serviceKey) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/rate_limit_events?key=eq.${encodeURIComponent(key)}&created_at=gte.${since}&select=id`,
      { headers }
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (rows.length >= maxRequests) return true;
    }
  } catch (e) {
    console.error('rate-limit check failed:', e.message);
    return false; // fail open on infra errors
  }

  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limit_events`, {
      method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ key }),
    });
  } catch (e) {
    console.error('rate-limit record failed:', e.message);
  }
  return false;
}
