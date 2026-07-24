// Uploads ONE property photo to Supabase Storage and returns its public URL.
// Client compresses/resizes the image before sending (see list-property.html)
// so this stays well under Vercel's request body limit even on slow connections.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { data, mimeType } = req.body || {};
    if (!data || !mimeType) {
      return res.status(400).json({ error: 'Missing image data or mimeType' });
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      return res.status(400).json({ error: 'Unsupported image type' });
    }

    const buffer = Buffer.from(data, 'base64');
    const MAX_BYTES = 2.5 * 1024 * 1024; // decoded size; base64 wire payload is ~33% larger, stays under Vercel's body limit
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ error: 'Image too large — please try a smaller photo' });
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

    const uploadResp = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/property-photos/${path}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': mimeType,
        },
        body: buffer,
      }
    );

    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      return res.status(400).json({ error: err });
    }

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/property-photos/${path}`;
    return res.status(200).json({ success: true, url: publicUrl });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
