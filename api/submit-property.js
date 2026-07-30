const CITIES = ['Lagos', 'Abuja', 'Jos', 'Kwara', 'Kebbi'];
const TYPES = ['self-con', 'mini-flat', 'flat', 'duplex', 'bungalow', 'terrace', 'mansion'];
const FLOOD_RISKS = ['Low risk', 'Moderate risk', 'High risk'];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(str, max) {
  return String(str).slice(0, max);
}

function validateProperty(body) {
  const name = truncate(escapeHtml((body.name || '').trim()), 100);
  if (!name) return { error: 'Property title is required' };

  const area = truncate(escapeHtml((body.area || '').trim()), 100);
  if (!area) return { error: 'Area/neighbourhood is required' };

  const city = (body.city || '').trim();
  if (!CITIES.includes(city)) return { error: 'Invalid city' };

  const type = (body.type || '').trim();
  if (!TYPES.includes(type)) return { error: 'Invalid property type' };

  const price = parseInt(body.price, 10);
  if (!Number.isFinite(price) || price <= 0 || price > 1000000000) {
    return { error: 'Invalid price' };
  }

  const bedrooms = parseInt(body.bedrooms, 10);
  if (!Number.isFinite(bedrooms) || bedrooms < 1 || bedrooms > 20) {
    return { error: 'Invalid number of bedrooms' };
  }
  const bathrooms = parseInt(body.bathrooms, 10);
  if (!Number.isFinite(bathrooms) || bathrooms < 1 || bathrooms > 20) {
    return { error: 'Invalid number of bathrooms' };
  }

  const description = truncate(escapeHtml((body.description || '').trim()), 2000);

  const rawAmenities = Array.isArray(body.amenities) ? body.amenities : [];
  const amenities = rawAmenities.slice(0, 30).map((a) => truncate(escapeHtml(String(a)), 50));

  const landlordName = truncate(escapeHtml((body.landlord_name || '').trim()), 100);
  if (!landlordName) return { error: 'Landlord name is required' };

  const phoneDigits = (body.landlord_phone || '').replace(/[^\d+]/g, '');
  if (!/^(\+?234\d{10}|0\d{10})$/.test(phoneDigits)) {
    return { error: 'Please enter a valid Nigerian phone number' };
  }

  let landlordEmail = (body.landlord_email || '').trim();
  if (landlordEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(landlordEmail) || landlordEmail.length > 254) {
      return { error: 'Please enter a valid email address' };
    }
    landlordEmail = escapeHtml(landlordEmail);
  }

  const ninNumber = (body.nin_number || '').trim();
  if (!/^\d{11}$/.test(ninNumber)) {
    return { error: 'NIN must be exactly 11 digits' };
  }

  const securityInfo = truncate(escapeHtml((body.security_info || '').trim()), 300);
  if (!securityInfo) return { error: 'Security info is required' };
  const waterInfo = truncate(escapeHtml((body.water_info || '').trim()), 300);
  if (!waterInfo) return { error: 'Water info is required' };
  const electricityInfo = truncate(escapeHtml((body.electricity_info || '').trim()), 300);
  if (!electricityInfo) return { error: 'Electricity info is required' };

  const floodRisk = (body.flood_risk || '').trim();
  if (!FLOOD_RISKS.includes(floodRisk)) return { error: 'Invalid flood risk value' };

  const nearbySchools = truncate(escapeHtml((body.nearby_schools || '').trim()), 300);
  const nearbyMarkets = truncate(escapeHtml((body.nearby_markets || '').trim()), 300);

  const rawPhotoUrls = Array.isArray(body.photo_urls) ? body.photo_urls : [];
  const expectedPrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/property-photos/`;
  const photoUrls = rawPhotoUrls
    .filter((u) => typeof u === 'string' && u.startsWith(expectedPrefix))
    .slice(0, 10);
  if (photoUrls.length < 3) {
    return { error: 'At least 3 valid property photos are required' };
  }

  return {
    data: {
      name, area, city, type, price, bedrooms, bathrooms, description, amenities,
      landlord_name: landlordName, landlord_phone: phoneDigits, landlord_email: landlordEmail,
      nin_number: ninNumber, security_info: securityInfo, water_info: waterInfo,
      electricity_info: electricityInfo, flood_risk: floodRisk,
      nearby_schools: nearbySchools, nearby_markets: nearbyMarkets, photo_urls: photoUrls,
    },
  };
}

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

    const validated = validateProperty(body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        ...validated.data,
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
