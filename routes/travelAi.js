const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// POST /api/ai/travel
router.post('/travel', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'message is required' });

    // Use the Responses API for concise output
    const response = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: `You are an AI travel assistant. Answer this travel question clearly and concisely: ${message}`,
    });

    // New SDK returns structured output; fall back to text
    const reply = response.output_text || (response.output && response.output[0] && response.output[0].content && response.output[0].content.map(c => c.text).join('\n')) || '';

    res.json({ success: true, reply });
  } catch (error) {
    console.error('travelAi error', error);
    res.status(500).json({ success: false, error: 'AI response failed. Please check API key or server logs.' });
  }
});

module.exports = router;
