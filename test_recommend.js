const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fetchImpl = async (...args) => {
  const nodeFetch = await import('node-fetch');
  return nodeFetch.default(...args);
};

function convertMessagesToPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map(m => `${m.role}: ${m.content}`).join('\n');
}

function extractGeminiText(data) {
  try {
    return data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  } catch (err) {
    return '';
  }
}

async function test() {
  const key = process.env.GEMINI_API_KEY;
  const model = "gemini-3.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const messages = [
    {
      role: 'system',
      content: 'You are a professional travel recommendation engine. Provide a highly detailed, beautifully structured list of top travel destinations in a clean markdown text format. Do not return JSON. Write in highly-detailed English using bold headers and nested bullet points. Ensure the response is long, complete, and extremely comprehensive.'
    },
    {
      role: 'user',
      content: `Provide 3 to 5 premium travel destination recommendations specifically within the country: **India** matching preferences: Historical and culture.\n\nFor each destination, you must write a very long, detailed explanation that strictly includes the following bullet points:\n- **🌟 Key Highlights & Attractions**: Detailed overview of must-see spots, scenic vistas, monuments, or landmarks.\n- **🎭 Cultural Experiences & Local Activities**: Detailed overview of local traditions, local events, tours, or immersive activities.\n- **🍽 Authentic Culinary Recommendations**: Specific traditional dishes, local street foods, or beverages to try.\n- **💡 Insider Tips for Travelers**: Highly practical tips on transport, safety, best viewing times, or local etiquette.\n\nMake sure each destination has rich, extensive prose under each bullet point. Do not return JSON or code blocks.`
    }
  ];

  const prompt = convertMessagesToPrompt(messages);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2000,
    }
  };

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    console.log("Status:", res.status);
    const text = extractGeminiText(data);
    console.log("Output Length:", text.length);
    console.log("Output Preview:\n", text.slice(0, 1000));
    console.log("End Preview:\n", text.slice(-500));
  } catch (err) {
    console.error(err);
  }
}

test();
