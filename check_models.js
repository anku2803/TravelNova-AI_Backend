const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fetchImpl = async (...args) => {
  const nodeFetch = await import('node-fetch');
  return nodeFetch.default(...args);
};

async function check() {
  const key = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  try {
    const res = await fetchImpl(url);
    const data = await res.json();
    console.log("Response status:", res.status);
    if (data.models) {
      console.log("Supported Models:");
      data.models.forEach(m => {
        if (m.supportedGenerationMethods.includes("generateContent")) {
          console.log(`- Name: ${m.name} (${m.displayName})`);
        }
      });
    } else {
      console.log("No models field. Response:", data);
    }
  } catch (err) {
    console.error("Error fetching models:", err);
  }
}

check();
