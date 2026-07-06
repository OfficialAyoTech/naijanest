export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { messages, system } = req.body;
    const truncatedSystem = system && system.length > 8000 ? system.substring(0, 8000) : system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: truncatedSystem,
        messages: messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude error:', data);
      return res.status(200).json({ 
        content: [{ type: 'text', text: 'I am having trouble connecting right now. Please try again.' }] 
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Server error:', error);
    return res.status(200).json({ 
      content: [{ type: 'text', text: 'I am having trouble right now. Please try again.' }] 
    });
  }
}
