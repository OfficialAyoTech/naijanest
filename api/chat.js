export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { messages, system } = req.body;
    const truncatedSystem = system && system.length > 8000 ? system.substring(0, 8000) : system;
    const groqMessages = [{ role: 'system', content: truncatedSystem }, ...messages];
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 800,
        temperature: 0.2,
        messages: groqMessages
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Groq error:', JSON.stringify(data));
      return res.status(200).json({ 
        content: [{ type: 'text', text: 'Hi! 👋 Our AI assistant is taking a short break right now. Please try again in a few minutes, or send a WhatsApp message to our support team for immediate help finding your perfect home 🏠' }] 
      });
    }
    const text = data.choices?.[0]?.message?.content || 'Sorry, please try again.';
    return res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(200).json({ 
      content: [{ type: 'text', text: 'Hi! 👋 Our AI assistant is taking a short break right now. Please try again in a few minutes, or send a WhatsApp message to our support team for immediate help finding your perfect home 🏠' }] 
    });
  }
}
