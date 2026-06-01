



const express = require('express');
const router = express.Router();

const fetchImpl =
  global.fetch ||
  (async (...args) => {
    const nodeFetch = await import('node-fetch');
    return nodeFetch.default(...args);
  });

function isConfigured() {
  return !!process.env.GEMINI_API_KEY || !!process.env.OPENAI_API_KEY;
}

function convertMessagesToPrompt(messages) {
  if (!Array.isArray(messages)) return '';

  return messages
    .map((m) => {
      const role = m.role || 'user';
      const content = m.content || '';
      return `${role}: ${content}`;
    })
    .join('\n');
}

function extractGeminiText(data) {
  try {
    return (
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('') || ''
    );
  } catch (err) {
    return '';
  }
}

async function callGemini(messages, maxTokens = 800) {
  const API_KEY = process.env.GEMINI_API_KEY;
  const MODEL = process.env.GOOGLE_MODEL_ID || 'gemini-3.5-flash';

  if (!API_KEY) {
    return 'AI is not configured. Please add GEMINI_API_KEY in your .env file.';
  }

  const prompt = convertMessagesToPrompt(messages);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: maxTokens,
    },
  };

  // Retry logic for transient errors (429, 5xx)
  const maxAttempts = 3;
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error(text);
      }

      if (!response.ok) {
        const msg = data?.error?.message || `Gemini API request failed (status ${response.status})`;
        // If this looks transient, retry
        if (response.status === 429 || response.status >= 500) {
          lastErr = new Error(msg);
          // exponential backoff
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
          continue;
        }
        throw new Error(msg);
      }

      const finalText = extractGeminiText(data);

      if (!finalText) {
        throw new Error('Gemini returned empty response');
      }

      return finalText;
    } catch (err) {
      lastErr = err;
      // if we've exhausted attempts, rethrow
      if (attempt >= maxAttempts) throw lastErr;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastErr || new Error('Unknown Gemini error');
}

async function callOpenAI(messages, maxTokens = 800) {
  const API_KEY = process.env.OPENAI_API_KEY;
  if (!API_KEY) throw new Error('OpenAI API key not configured');

  // Use the Chat Completions endpoint as a reliable fallback
  const url = 'https://api.openai.com/v1/chat/completions';

  // messages is expected to be an array of {role, content}
  const body = {
    model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
    messages: messages,
    max_tokens: maxTokens,
    temperature: 0.7,
  };

  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(text);
  }

  if (!resp.ok) {
    throw new Error(data?.error?.message || `OpenAI request failed (status ${resp.status})`);
  }

  // assemble reply text
  try {
    const choice = data.choices && data.choices[0];
    if (choice && choice.message && choice.message.content) return choice.message.content;
  } catch (e) {
    // fallthrough
  }

  // fallback to any text fields
  return data?.choices?.[0]?.text || '';
}

function tryParseAiOutput(ai) {
  // ai may be: 1) a JSON string (object/array), 2) a JSON-encoded string ("{...}"),
  // 3) plain text. Try multiple strategies to get a usable object.
  if (!ai || typeof ai !== 'string') return ai;

  // 1) direct parse
  try {
    const parsed = JSON.parse(ai);
    // if parsed is a string (double-encoded), attempt parse again
    if (typeof parsed === 'string') {
      try {
        return JSON.parse(parsed);
      } catch (e) {
        return { text: parsed };
      }
    }
    return parsed;
  } catch (e) {
    // 2) maybe ai is a quoted string with escaped quotes, try unquoting
    const trimmed = ai.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      const unquoted = trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
      try {
        return JSON.parse(unquoted);
      } catch (e2) {
        return { text: unquoted };
      }
    }

    // 3) if it looks like JSON text (starts with { or [), try parse directly
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch (e3) {
        return { text: ai };
      }
    }

    // fallback: return as text
    // Attempt to extract a JSON substring if the AI appended extra text
    const firstBrace = ai.search(/[\[{]/);
    const lastBrace = Math.max(ai.lastIndexOf('}'), ai.lastIndexOf(']'));
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      // try progressively trimming the tail until parse succeeds
      for (let end = lastBrace; end > firstBrace; end--) {
        const candidate = ai.slice(firstBrace, end + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          // continue trimming
        }
      }
    }

    return { text: ai };
  }
}

router.post('/chat', async (req, res) => {
  try {
    const { messages, message } = req.body;

    let finalMessages = [
      {
        role: 'system',
        content: 'You are a friendly, highly professional travel assistant. Answer clearly and helpfully with in-depth and structured detail, utilizing lists, headings, and bold formatting where appropriate. Do not return JSON.',
      },
    ];

    if (Array.isArray(messages)) {
      finalMessages = finalMessages.concat(messages);
    } else if (message) {
      finalMessages.push({
        role: 'user',
        content: message,
      });
    } else {
      return res.status(400).json({
        ok: false,
        error: 'message or messages required',
      });
    }

    let reply;
    try {
      if (process.env.GEMINI_API_KEY) {
        reply = await callGemini(finalMessages, 8000);
      } else if (process.env.OPENAI_API_KEY) {
        reply = await callOpenAI(finalMessages, 2000);
      } else {
        throw new Error('No live AI service keys (GEMINI_API_KEY or OPENAI_API_KEY) configured in .env file.');
      }
    } catch (err) {
      if (process.env.OPENAI_API_KEY) {
        reply = await callOpenAI(finalMessages, 800);
      } else {
        throw err;
      }
    }

    res.json({ ok: true, reply });
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.json({
      ok: false,
      error: err.message,
    });
  }
});

// persist chat history
router.post('/chat/save', async (req, res) => {
  try {
    const { sessionId, messages, reply } = req.body;
    if (!messages) return res.status(400).json({ ok: false, error: 'messages required' });
    const msgs = typeof messages === 'string' ? messages : JSON.stringify(messages);
    const sql = 'INSERT INTO chats (session_id, messages, reply) VALUES (?,?,?)';
    const params = [sessionId || null, msgs, reply || null];
    db.run(sql, params, function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID });
    });
  } catch (err) {
    console.error('chat save error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/chat/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  db.all('SELECT id, session_id, messages, reply, created_at FROM chats ORDER BY created_at DESC LIMIT ?', [limit], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    const parsed = rows.map(r => ({ ...r, messages: (() => { try { return JSON.parse(r.messages); } catch (e) { return r.messages; } })() }));
    res.json({ ok: true, data: parsed });
  });
});

router.post('/plan', async (req, res) => {
  try {
    const { destination, budget, days, travelType, startCity } = req.body;

    if (!destination || !days || !travelType) {
      return res.status(400).json({
        ok: false,
        error: 'destination, days and travelType are required',
      });
    }

    const messages = [
      {
        role: 'system',
        content:
          'You are an expert travel planner. Create highly detailed, beautifully formatted travel plans in clean markdown text. Use headings, bold formatting, lists, and paragraphs. Do not return JSON. Write in plain, beautiful, highly-scannable English prose.',
      },
      {
        role: 'user',
        content: `Create a comprehensive and highly detailed day-by-day travel itinerary for exactly ${days} days in ${destination}. Traveler type: ${travelType}. Starting city: ${startCity || 'not specified'}. Budget: ${budget || 'not specified'}. You MUST write exactly ${days} distinct daily sections (e.g., Day 1: [Title], Day 2: [Title], ..., Day ${days}: [Title]). Inside each day's plan, write a detailed description of morning, afternoon, and evening activities, local food suggestions, lodging recommendations, and estimated costs. Do not return JSON or code blocks.`,
      },
    ];

    let ai;
    try {
      if (process.env.GEMINI_API_KEY) {
        ai = await callGemini(messages, 8000);
      } else if (process.env.OPENAI_API_KEY) {
        ai = await callOpenAI(messages, 4000);
      } else {
        throw new Error('No live AI service keys (GEMINI_API_KEY or OPENAI_API_KEY) configured in .env file.');
      }
    } catch (err) {
      if (process.env.OPENAI_API_KEY) {
        ai = await callOpenAI(messages, 1500);
      } else {
        throw err;
      }
    }

    const parsed = tryParseAiOutput(ai);
    res.json({ ok: true, data: parsed });
  } catch (err) {
    console.error('AI plan error:', err.message);
    res.json({
      ok: false,
      error: err.message,
    });
  }
});

router.post('/guide', async (req, res) => {
  try {
    const { destination } = req.body;

    if (!destination) {
      return res.status(400).json({
        ok: false,
        error: 'destination required',
      });
    }

    const messages = [
      {
        role: 'system',
        content:
          'You are a travel guide assistant. Provide highly detailed, beautiful travel brochures in clean markdown text. Do not return JSON. Write in plain, beautiful, detailed English prose.',
      },
      {
        role: 'user',
        content: `Provide a comprehensive, detailed travel guide for ${destination}. Include sections for best time to visit, famous local foods, transport options, safety tips, and estimated expenses in clean plain text with bold headings.`,
      },
    ];

    let ai;
    try {
      if (process.env.GEMINI_API_KEY) {
        ai = await callGemini(messages, 8000);
      } else if (process.env.OPENAI_API_KEY) {
        ai = await callOpenAI(messages, 3000);
      } else {
        throw new Error('No live AI service keys (GEMINI_API_KEY or OPENAI_API_KEY) configured in .env file.');
      }
    } catch (err) {
      if (process.env.OPENAI_API_KEY) {
        ai = await callOpenAI(messages, 1000);
      } else {
        throw err;
      }
    }

    const parsed = tryParseAiOutput(ai);
    res.json({ ok: true, data: parsed });
  } catch (err) {
    console.error('AI guide error:', err.message);
    res.json({
      ok: false,
      error: err.message,
    });
  }
});

router.post('/recommend', async (req, res) => {
  try {
    const { preferences, country } = req.body;

    if (!country) {
      return res.status(400).json({
        ok: false,
        error: 'country is required',
      });
    }

    const prefText = preferences ? `matching preferences: ${preferences}` : 'general recommendations';
    const messages = [
      {
        role: 'system',
        content: 'You are a professional travel recommendation engine. Provide a highly detailed, beautifully structured list of top travel destinations in a clean markdown text format. Do not return JSON. Write in highly-detailed English using bold headers and nested bullet points. Ensure the response is long, complete, and extremely comprehensive.'
      },
      {
        role: 'user',
        content: `Provide 3 to 5 premium travel destination recommendations specifically within the country: **${country}** ${prefText}.\n\nFor each destination, you must write a very long, detailed explanation that strictly includes the following bullet points:\n- **🌟 Key Highlights & Attractions**: Detailed overview of must-see spots, scenic vistas, monuments, or landmarks.\n- **🎭 Cultural Experiences & Local Activities**: Detailed overview of local traditions, local events, tours, or immersive activities.\n- **🍽 Authentic Culinary Recommendations**: Specific traditional dishes, local street foods, or beverages to try.\n- **💡 Insider Tips for Travelers**: Highly practical tips on transport, safety, best viewing times, or local etiquette.\n\nMake sure each destination has rich, extensive prose under each bullet point. Do not return JSON or code blocks.`
      }
    ];

    let ai;
    try {
      if (process.env.GEMINI_API_KEY) {
        ai = await callGemini(messages, 8000);
      } else if (process.env.OPENAI_API_KEY) {
        ai = await callOpenAI(messages, 4000);
      } else {
        throw new Error('No live AI service keys (GEMINI_API_KEY or OPENAI_API_KEY) configured in .env file.');
      }
    } catch (err) {
      if (process.env.OPENAI_API_KEY) {
        ai = await callOpenAI(messages, 1500);
      } else {
        throw err;
      }
    }

    const parsed = tryParseAiOutput(ai);
    res.json({ ok: true, data: parsed });
  } catch (err) {
    console.error('AI recommend error:', err.message);
    res.json({
      ok: false,
      error: err.message,
    });
  }
});

router.get('/status', (req, res) => {
  res.json({
    ok: true,
    config: {
      hasApiKey: isConfigured(),
      model: process.env.GOOGLE_MODEL_ID || 'gemini-3.5-flash',
    },
  });
});

module.exports = router;