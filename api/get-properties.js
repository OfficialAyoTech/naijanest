export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const PUBLIC_FIELDS = [
      'id', 'name', 'area', 'city', 'bedrooms', 'bathrooms', 'price', 'type',
      'description', 'amenities', 'photo_urls', 'featured', 'featured_until',
      'security_info', 'water_info', 'electricity_info', 'flood_risk',
      'nearby_schools', 'nearby_markets', 'landlord_phone', 'created_at',
    ].join(',');

    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/properties?status=eq.approved&order=created_at.desc&select=${PUBLIC_FIELDS}`,
      { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` } }
    );
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
