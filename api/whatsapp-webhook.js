import crypto from 'crypto';
import { logError } from '../lib/notify.js';
import { toE164 } from '../lib/waitlist-whatsapp.js';

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

// Plain text reply inside the 24h customer-service window (the person just
// messaged us, so no template is needed).
async function sendWhatsAppText(to, body) {
  const sendResp = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  if (!sendResp.ok) {
    console.error('whatsapp webhook: WhatsApp send failed:', sendResp.status, await sendResp.text());
    return false;
  }
  console.log('whatsapp webhook: reply sent successfully to', to);
  return true;
}

// The waitlist outreach template's footer promises "Reply STOP to opt out",
// so that has to actually work. Kept to unambiguous phrases only — words like
// "cancel" or "end" are too likely to appear in a normal chat with the bot.
const OPT_OUT_PHRASES = new Set(['stop', 'unsubscribe', 'opt out', 'opt-out', 'optout', 'stop messages']);
function isOptOut(text) {
  return OPT_OUT_PHRASES.has(String(text || '').trim().toLowerCase().replace(/[.!\s]+$/, ''));
}

// Marks any waitlist row(s) matching this WhatsApp number as opted out.
// Requires: alter table waitlist add column if not exists opted_out_at timestamptz;
// The waitlist is small, so it's fetched and matched in JS on normalized
// digits — that way 0810..., +234 810... and 234810... all match.
async function handleOptOut(from, headers) {
  try {
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist?select=id,whatsapp`, { headers });
    if (resp.ok) {
      const rows = await resp.json();
      const ids = rows.filter(r => toE164(r.whatsapp) === from).map(r => r.id);
      if (ids.length) {
        const patchResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/waitlist?id=in.(${ids.join(',')})`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ opted_out_at: new Date().toISOString() }),
        });
        if (!patchResp.ok) {
          await logError('whatsapp-webhook-optout', new Error(`Could not record opt-out for ${from}: ${(await patchResp.text()).slice(0, 300)}`));
        }
      }
    }
  } catch (e) {
    console.error('whatsapp webhook: opt-out handling failed:', e.message);
    await logError('whatsapp-webhook-optout', e);
  }
  await sendWhatsAppText(from, "You've been unsubscribed and won't receive more announcements from NaijaNest. You can still message us here any time to search for a home 🏠");
}

// Reads the admin-controlled platform fee (Admin > Payments), the same
// site_content row paystack-initialize.js reads. Defaults to 0 (launch
// pricing) if it was never set.
async function getPlatformFeePercent(headers) {
  try {
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/site_content?key=eq.platform_fee_percent&select=html`, { headers });
    if (resp.ok) {
      const rows = await resp.json();
      if (rows[0]) {
        const percent = Number(JSON.parse(rows[0].html).percent);
        if (Number.isFinite(percent) && percent >= 0) return percent;
      }
    }
  } catch (e) {
    console.error('whatsapp webhook: platform fee lookup failed:', e.message);
  }
  return 0;
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

    // Opt-out requests are handled before anything else — no AI call, no
    // session, and they never get blocked by the rate limit below.
    if (isOptOut(text)) {
      await handleOptOut(from, headers);
      return res.status(200).send('EVENT_RECEIVED');
    }

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

    const platformFeePercent = await getPlatformFeePercent(headers);
    const platformFeeRule = platformFeePercent > 0
      ? `NaijaNest charges a platform fee of ${platformFeePercent}% of the annual rent, so ALWAYS include platform fee = price × ${platformFeePercent}/100 in the total.`
      : `NaijaNest currently charges NO platform fee, so do not add one.`;

    const system = `You are the NaijaNest AI assistant, chatting with a user over WhatsApp. NaijaNest is Nigeria's AI-powered house rental assistant.

${coverageLine}

RULES:
1. Only ever mention properties from the JSON list below — never invent a property, price, or address.
2. Match a requested state/city against each property's "city" field (case-insensitive). "Ilorin" means city="Kwara". "Jos" means city="Plateau" (Jos is a city within Plateau State, not its own state). "FCT" means city="Abuja".
3. If the list is empty, or nothing matches the requested city, say NaijaNest doesn't have verified listings there yet and that new ones are added regularly. Do not invent one.
4. This is WhatsApp — plain text only. No markdown tables, no special card syntax. Keep replies short and scannable: a few lines per property (name, area, price, one line of neighborhood info), not paragraphs.
5. Answer questions about security, water, electricity, and flood risk using the fields provided for that property.
6. If asked how to submit a property, tell them listing is free and to visit naijanestai.com.ng/list-property.html.
7. Be warm and conversational, like a knowledgeable friend, not a formal customer service bot.
8. FULL COST QUESTIONS: if asked the total/actual cost, or about agency/documentation/caution fees, use agency_fee_percent, legal_fee_percent (this is the documentation fee), and caution_fee on that property. Agency and documentation fees only apply when that listing's landlord or agent actually charges them — null or 0 means none is listed for that property, so say that and suggest confirming with the landlord; never guess a percentage. Agency fee = price × agency_fee_percent/100 and documentation fee = price × legal_fee_percent/100. The caution fee is a deposit set by the landlord and refundable at the end of the tenancy; it is not a NaijaNest fee. ${platformFeeRule} Total = price + any agency fee + any documentation fee + caution_fee + any platform fee. Show the full breakdown, not just one number.

CURRENT VERIFIED LISTINGS (JSON):
${JSON.stringify(propsForPrompt)}`;

    // ---- Call Groq, trying each model in turn ----
    // Set GROQ_MODELS in Vercel (comma-separated, best model first) to the
    // same list chat.js uses, so both stay in step when Groq retires a model.
    // Any error on one model (rate limit, retired model, outage) moves on to
    // the next instead of giving up.
    console.log('whatsapp webhook: calling Groq...');
    const models = (process.env.GROQ_MODELS || 'llama-3.3-70b-versatile,llama-3.1-8b-instant')
      .split(',').map(m => m.trim()).filter(Boolean);
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
          continue;
        }
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          reply = content;
          break;
        }
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
    await sendWhatsAppText(from, reply);

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('whatsapp webhook error:', error.message, '| cause:', error.cause, '| stack:', error.stack);
    await logError('whatsapp-webhook', error);
    return res.status(200).send('EVENT_RECEIVED');
  }
}
