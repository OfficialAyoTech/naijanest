export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, system } = req.body;
  const truncatedSystem = system && system.length > 8000 ? system.substring(0, 8000) : system;
  const groqMessages = [{ role: 'system', content: truncatedSystem }, ...messages];

  // Try primary model first, fall back to backup if rate limited
  const models = [
    'llama-3.3-70b-versatile',  // Primary - smarter
    'llama-3.1-8b-instant',     // Backup - faster, uses fewer tokens
    'gemma2-9b-it'              // Last resort
  ];

  for (const model of models) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          max_tokens: 800,
          temperature: 0.2,
          messages: groqMessages
        })
      });

      const data = await response.json();

      // If rate limited, try next model
      if (!response.ok) {
        const errorCode = data?.error?.code;
        if (errorCode === 'rate_limit_exceeded') {
          console.log(`Model ${model} rate limited, trying next...`);
          continue; // Try next model
        }
        // Other error - return friendly message
        console.error(`Model ${model} error:`, JSON.stringify(data));
        return res.status(200).json({
          content: [{ type: 'text', text: 'Hi! 👋 Our AI assistant is taking a short break. Please try again in a few minutes 🙏' }]
        });
      }

      const text = data.choices?.[0]?.message?.content || 'Sorry, please try again.';
      console.log(`Responded using model: ${model}`);
      return res.status(200).json({ content: [{ type: 'text', text }] });

    } catch (error) {
      console.error(`Error with model ${model}:`, error.message);
      continue; // Try next model
    }
  }

  // All models failed
  return res.status(200).json({
    content: [{ type: 'text', text: 'Hi! 👋 Our AI assistant is taking a short break right now. Please try again in a few minutes 🙏' }]
  });
}
