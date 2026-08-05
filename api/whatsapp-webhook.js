import crypto from 'crypto';

// Vercel must not pre-parse the body — we need the exact raw bytes to verify Meta's
// X-Hub-Signature-256 header, same reasoning as paystack-webhook.js.
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Shared rate-limit table with chat.js (rate_limit_events: key, created_at).
// Returns true if this key has already hit maxRequests within windowMinutes.
// Self-hosted error monitoring: logs to a Supabase table and sends a WhatsApp
// alert to the admin, at most once per 15 minutes per source, so a real problem
// gets noticed without spamming the phone on repeated/flapping errors.
async function logError(source, error) {
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
    const message = (error?.message || String(error)).slice(0, 2000);
    const stack = (error?.stack || '').slice(0, 4000);

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const recentResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/error_logs?source=eq.${encodeURIComponent(source)}&created_at=gte.${since}&select=id&limit=1`,
      { headers }
    );
    const recentRows = recentResp.ok ? await recentResp.json() : [];
    const shouldAlert = recentRows.length === 0;

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/error_logs`, {
      method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ source, message, stack }),
    });

    if (shouldAlert && process.env.ADMIN_WHATSAPP_NUMBER && process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
      const digits = String(process.env.ADMIN_WHATSAPP_NUMBER).replace(/\D/g, '');
      const e164 = digits.startsWith('234') ? digits : digits.startsWith('0') ? '234' + digits.slice(1) : digits;
      await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: e164, type: 'text',
          text: { body: `🚨 NaijaNest error in ${source}:\n${message.slice(0, 300)}` },
        }),
      });
    }
  } catch (e) {
    console.error('logError itself failed:', e.message);
  }
}

async function isRateLimited(key, maxRequests, windowMinutes, serviceKey) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/rate_limit_events?key=eq.${encodeURIComponent(key)}&created_at=gte.${since}&select=id`,
      { headers }
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (rows.length >= maxRequests) return true;
    }
  } catch (e) {
    console.error('whatsapp webhook: rate-limit check failed:', e.message);
    return false; // fail open on infra errors
  }

  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/rate_limit_events`, {
      method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ key }),
    });
  } catch (e) {
    console.error('whatsapp webhook: rate-limit record failed:', e.message);
  }
  return false;
}

// WhatsApp Cloud API webhook (Meta direct — no BSP markup).
// GET  = Meta's one-time webhook verification handshake.
// POST = incoming message events.
// Everything is inline in this one exported function (no delegate helper for
// the request handling itself) to match every other endpoint in this project.
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  }

  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const rawBody = await getRawBody(req);

  // Verify this really came from Meta before doing anything else with it.
  // Meta signs the request body with our App Secret (HMAC SHA-256); anything
  // without a matching signature is rejected outright.
  const signatureHeader = req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error('whatsapp webhook: META_APP_SECRET is not set — rejecting all requests until configured');
    return res.status(500).send('Server misconfigured');
  }
  const expectedSignature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const signatureValid =
    typeof signatureHeader === 'string' &&
    signatureHeader.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature));

  if (!signatureValid) {
    console.error('whatsapp webhook: invalid or missing X-Hub-Signature-256, rejecting');
    return res.status(401).send('Invalid signature');
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).send('Invalid JSON');
  }

  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message || message.type !== 'text') {
      console.log('whatsapp webhook: no text message in payload, ignoring');
      return res.status(200).send('EVENT_RECEIVED');
    }

    const from = message.from; // sender's WhatsApp number, E.164 digits, no '+'
    const text = message.text.body;
    console.log('whatsapp webhook: received message from', from, '-', text);

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

    // Per-phone-number rate limit — signature verification already blocks spoofed
    // requests, but a real user could still script rapid-fire messages from their
    // own number to run up Groq costs. 20 messages / 10 min is generous for a real
    // conversation but blocks scripted abuse.
    const rateLimited = await isRateLimited(`whatsapp:${from}`, 20, 10, serviceKey);
    if (rateLimited) {
      console.log('whatsapp webhook: rate limit hit for', from, '- silently dropping');
      return res.status(200).send('EVENT_RECEIVED');
    }

    console.log('whatsapp webhook: loading session...');
    const sessionResp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/whatsapp_sessions?phone=eq.${from}&select=messages`,
      { headers }
    );
    console.log('whatsapp webhook: session fetch status', sessionResp.status);
    if (!sessionResp.ok) console.error('whatsapp webhook: session load failed:', await sessionResp.text());
    const sessionRows = await sessionResp.json();
    let history = (sessionRows[0]?.messages) || [];

    history.push({ role: 'user', content: text });
    if (history.length > 20) history = history.slice(-20); // keep context bounded

    // ---- Build the system prompt from real, approved listings ----
    console.log('whatsapp webhook: fetching properties...');
    let properties = [];
    try {
      const propResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/properties?status=eq.approved&order=featured.desc`,
        { headers }
      );
      properties = await propResp.json();
    } catch (e) {
      console.error('whatsapp webhook: property fetch failed:', e.message);
    }
    const propsForPrompt = properties.map(p => ({
      id: p.id, name: p.name, area: p.area, lga: p.lga, city: p.city, bedrooms: p.bedrooms,
      price: p.price, type: p.type,
      agency_fee_percent: p.agency_fee_percent, legal_fee_percent: p.legal_fee_percent, caution_fee: p.caution_fee,
      security: p.security_info || '', water: p.water_info || '',
      electricity: p.electricity_info || '', flood: p.flood_risk || '',
    }));
    const activeCities = [...new Set(propsForPrompt.map(p => p.city))];
    const coverageLine = activeCities.length
      ? `You currently have verified listings in: ${activeCities.join(', ')}.`
      : `You don't have any verified listings yet — new ones are added regularly.`;
    const system = `You are the NaijaNest AI assistant, chatting with a user over WhatsApp. NaijaNest is Nigeria's AI-powered house rental assistant.

${coverageLine}

RULES:
1. Only ever mention properties from the JSON list below — never invent a property, price, or address.
2. Match a requested state/city against each property's "city" field (case-insensitive). "Ilorin" means city="Kwara". "Jos" means city="Plateau" (Jos is a city within Plateau State, not its own state). "FCT" means city="Abuja".
3. If the list is empty, or nothing matches the requested city, say NaijaNest doesn't have verified listings there yet and that new ones are added regularly. Do not invent one.
4. This is WhatsApp — plain text only. No markdown tables, no special card syntax. Keep replies short and scannable: a few lines per property (name, area, price, one line of neighborhood info), not paragraphs.
5. Answer questions about security, water, electricity, and flood risk using the fields provided for that property.
6. If asked how to submit a property, tell them to visit naijanest.vercel.app/list-property.html.
7. Be warm and conversational, like a knowledgeable friend, not a formal customer service bot.
8. FULL COST QUESTIONS: if asked the total/actual cost, or about agency/legal/caution fees, use agency_fee_percent, legal_fee_percent, and caution_fee on that property. Compute agency fee = price × agency_fee_percent/100, legal fee = price × legal_fee_percent/100, total = price + agency fee + legal fee + caution_fee (skip any field that's null). Show the breakdown, not just one number. If a fee field is null, say that fee hasn't been listed yet and to ask the landlord directly — never guess a percentage.

CURRENT VERIFIED LISTINGS (JSON):
${JSON.stringify(propsForPrompt)}`;

    // ---- Call Groq, with the same model fallback as the web chat ----
    console.log('whatsapp webhook: calling Groq...');
    const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'];
    const messages = [{ role: 'system', content: system }, ...history];
    let reply = "Hi! 👋 Our AI assistant is taking a short break right now. Please try again in a few minutes 🙏";
    for (const model of models) {
      try {
        const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({ model, max_tokens: 500, temperature: 0.2, messages }),
        });
        const data = await groqResp.json();
        if (!groqResp.ok) {
          console.error('whatsapp webhook: Groq error on', model, data?.error);
          if (data?.error?.code === 'rate_limit_exceeded') continue;
          break;
        }
        reply = data.choices?.[0]?.message?.content || reply;
        break;
      } catch (e) {
        console.error('whatsapp webhook: Groq fetch failed on', model, e.message);
        continue;
      }
    }
    console.log('whatsapp webhook: Groq replied:', reply.slice(0, 150));

    history.push({ role: 'assistant', content: reply });

    console.log('whatsapp webhook: saving session...');
    const saveResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/whatsapp_sessions`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ phone: from, messages: history, updated_at: new Date().toISOString() }),
    });
    if (!saveResp.ok) console.error('whatsapp webhook: session save failed:', await saveResp.text());

    console.log('whatsapp webhook: sending reply via WhatsApp...');
    const sendResp = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: reply },
      }),
    });
    if (!sendResp.ok) {
      console.error('whatsapp webhook: WhatsApp send failed:', sendResp.status, await sendResp.text());
    } else {
      console.log('whatsapp webhook: reply sent successfully to', from);
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('whatsapp webhook error:', error.message, '| cause:', error.cause, '| stack:', error.stack);
    await logError('whatsapp-webhook', error);
    return res.status(200).send('EVENT_RECEIVED');
  }
}
