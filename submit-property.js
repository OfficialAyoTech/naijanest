exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };
  try {
    const body = JSON.parse(event.body);
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/properties`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        name: body.name,
        area: body.area,
        city: body.city,
        bedrooms: parseInt(body.bedrooms),
        bathrooms: parseInt(body.bathrooms),
        price: parseInt(body.price),
        type: body.type,
        description: body.description,
        amenities: body.amenities,
        landlord_name: body.landlord_name,
        landlord_phone: body.landlord_phone,
        landlord_email: body.landlord_email,
        nin_number: body.nin_number,
        status: 'pending'
      })
    });
    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, headers, body: JSON.stringify({ error: err }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
