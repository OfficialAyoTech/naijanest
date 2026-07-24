// Returns ALL properties + waitlist data for the admin dashboard.
// Gated by ADMIN_PASSWORD (checked server-side, never trust the client).
// Uses SUPABASE_SERVICE_ROLE_KEY so this works even after RLS locks the
// anon key down to "approved properties only" (see migration notes).
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { admin_password } = req.body || {};
    if (!admin_password || admin_password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is not set' });
    }

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    };

    const [propsResp, waitlistResp] = await Promise.all([
      fetch(`${process.env.SUPABASE_URL}/rest/v1/properties?order=created_at.desc`, { headers }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist?order=created_at.desc`, { headers }),
    ]);

    if (!propsResp.ok) {
      const err = await propsResp.text();
      return res.status(400).json({ error: `properties: ${err}` });
    }
    if (!waitlistResp.ok) {
      const err = await waitlistResp.text();
      return res.status(400).json({ error: `waitlist: ${err}` });
    }

    const properties = await propsResp.json();
    const waitlist = await waitlistResp.json();

    return res.status(200).json({ properties, waitlist });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
