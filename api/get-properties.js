export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache at Vercel's edge for 30s, serve a stale copy for up to 2 more minutes while
  // refreshing in the background. Listings don't change second-to-second, so this
  // cuts repeat-visitor load on Supabase substantially with only a small, acceptable
  // delay before a newly-approved listing appears for everyone.
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    // IMPORTANT: this is a public, unauthenticated endpoint — only select fields that are
    // safe to expose to any visitor. Never use select=* here. In particular, nin_number,
    // landlord_email, landlord_name, and user_id must never be returned to the client.
    const PUBLIC_FIELDS = [
      'id', 'name', 'area', 'city', 'lga', 'bedrooms', 'bathrooms', 'price', 'type',
      'description', 'amenities', 'photo_urls', 'featured', 'featured_until',
      'security_info', 'water_info', 'electricity_info', 'flood_risk',
      'nearby_schools', 'nearby_markets', 'landlord_phone', 'created_at',
      'agency_fee_percent', 'legal_fee_percent', 'caution_fee',
    ].join(',');

    // Safety cap — harmless today with a handful of listings, but prevents every
    // homepage load from pulling an unbounded, ever-growing table once inventory
    // scales up. Revisit with real pagination if you ever approach this number.
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/properties?status=eq.approved&order=created_at.desc&select=${PUBLIC_FIELDS}&limit=200`,
      { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` } }
    );
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
