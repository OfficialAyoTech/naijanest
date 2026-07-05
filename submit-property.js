export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body;
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
        nin_number: body.nin_number, status: 'pending'
      })
    });
    if (!response.ok) { const err = await response.text(); return res.status(400).json({ error: err }); }
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
