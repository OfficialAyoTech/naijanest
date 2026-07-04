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
    const { messages, system } = body;
    
    // Truncate system if too long
    const truncatedSystem = system && system.length > 8000 ? system.substring(0, 8000) : system;
    
    const groqMessages = [{ role: 'system', content: truncatedSystem }, ...messages];
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
      },
      body: JSON.stringify({ 
        model: 'llama-3.1-8b-instant', 
        max_tokens: 800, 
        temperature: 0.3,
        messages: groqMessages 
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ content: [{ type: 'text', text: 'I am having trouble connecting right now. Please try again in a moment.' }] }) 
      };
    }
    
    const text = data.choices?.[0]?.message?.content || 'Sorry, I could not process that. Please try again.';
    return { statusCode: 200, headers, body: JSON.stringify({ content: [{ type: 'text', text }] }) };
  } catch (error) {
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({ content: [{ type: 'text', text: 'I am having trouble right now. Please try again.' }] }) 
    };
  }
};
