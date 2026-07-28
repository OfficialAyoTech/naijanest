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

  try {
    const entry = req.body?.entry?.[0];
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
      id: p.id, name: p.name, area: p.area, city: p.city, bedrooms: p.bedrooms,
      price: p.price, type: p.type,
      security: p.security_info || '', water: p.water_info || '',
      electricity: p.electricity_info || '', flood: p.flood_risk || '',
    }));
    const system = `You are the NaijaNest AI assistant, chatting with a user over WhatsApp. NaijaNest is Nigeria's AI-powered house rental assistant, covering Lagos, Abuja, Jos, Kwara, and Kebbi.

RULES:
1. Only ever mention properties from the JSON list below — never invent a property, price, or address.
2. Match a requested state/city against each property's "city" field (case-insensitive). "Ilorin" means city="Kwara". "Jos" or "Plateau" means city="Jos". "FCT" means city="Abuja".
3. If the list is empty, or nothing matches the requested city, say NaijaNest doesn't have verified listings there yet and that new ones are added regularly. Do not invent one.
4. This is WhatsApp — plain text only. No markdown tables, no special card syntax. Keep replies short and scannable: a few lines per property (name, area, price, one line of neighborhood info), not paragraphs.
5. Answer questions about security, water, electricity, and flood risk using the fields provided for that property.
6. If asked how to submit a property, tell them to visit naijanest.vercel.app/list-property.html.
7. Be warm and conversational, like a knowledgeable friend, not a formal customer service bot.

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
    return res.status(200).send('EVENT_RECEIVED');
  }
}
