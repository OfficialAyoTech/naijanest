// Merged with what used to be a separate waitlist-count.js — Vercel's Hobby
// plan caps serverless functions at 12, and adding book-inspection.js pushed
// past that. Same dispatch-by-method pattern already used in paystack-verify.js.
//
// GET  -> public waitlist count only (the table itself has no public SELECT
//         since Phase 1 locked it down, so this is the only way the landing
//         page counter can show a number without exposing anyone's data).
// POST -> join the waitlist.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return handleCount(req, res);
  if (req.method === 'POST') return handleJoin(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleCount(req, res) {
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

async function handleJoin(req, res) {
  try {
    const body = req.body;
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ name: body.name, whatsapp: body.whatsapp, city: body.city, role: body.role }),
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(400).json({ error: err });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
