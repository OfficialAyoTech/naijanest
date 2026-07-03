exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };
  try {
    const { messages, system } = JSON.parse(event.body);
    const groqMessages = [{ role: 'system', content: system }, ...messages];
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', max_tokens: 1000, messages: groqMessages })
    });
    const data = await response.json();
    if (!response.ok) return { statusCode: response.status, headers, body: JSON.stringify({ error: data }) };
    const text = data.choices?.[0]?.message?.content || '';
    return { statusCode: 200, headers, body: JSON.stringify({ content: [{ type: 'text', text }] }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
