// Public endpoint: returns ONLY the waitlist count, nothing else.
// Needed because Phase 1 locked the waitlist table down (no public SELECT),
// so the old client-side "count=exact" trick against the anon key no longer works.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist?select=id`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
    const contentRange = resp.headers.get('content-range');
    let count = 0;
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)/);
      if (match) count = parseInt(match[1], 10);
    }
    return res.status(200).json({ count });
  } catch (error) {
    return res.status(200).json({ count: 0 });
  }
}
