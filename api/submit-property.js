export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body;

    const accessToken = body.access_token;
    if (!accessToken) {
      return res.status(401).json({ error: 'Please sign in to list a property' });
    }
    const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!userResp.ok) {
      return res.status(401).json({ error: 'Your session has expired - please sign in again' });
    }
    const user = await userResp.json();

    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        name: body.name, area: body.area, city: body.city,
        bedrooms: parseInt(body.bedrooms), bathrooms: parseInt(body.bathrooms),
        price: parseInt(body.price), type: body.type, description: body.description,
        amenities: body.amenities, landlord_name: body.landlord_name,
        landlord_phone: body.landlord_phone, landlord_email: body.landlord_email,
        nin_number: body.nin_number,
        security_info: body.security_info, water_info: body.water_info,
        electricity_info: body.electricity_info, flood_risk: body.flood_risk,
        nearby_schools: body.nearby_schools, nearby_markets: body.nearby_markets,
        photo_urls: body.photo_urls || [],
        user_id: user.id,
        status: 'pending'
      })
    });
    if (!response.ok) { const err = await response.text(); return res.status(400).json({ error: err }); }

    try {
      await tagAsLandlordIfNeeded(user.id);
    } catch (e) {
      console.error('submit-property: role auto-tag failed:', e.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function tagAsLandlordIfNeeded(userId) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const profResp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=role`,
    { headers }
  );
  if (!profResp.ok) return;
  const rows = await profResp.json();
  const currentRole = rows[0]?.role;

  if (currentRole === 'landlord' || currentRole === 'agent') return;

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ role: 'landlord' }),
  });
}
