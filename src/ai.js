// FAQ-scope AI consultant: Gemini Flash (free tier) as primary, DeepSeek as
// fallback when Gemini rate-limits. No conversation history — each question
// is an independent request built from the current services/masters snapshot.
import { db } from './database.js';

const GEMINI_MODEL = 'gemini-2.0-flash'; // verify current free-tier model name at integration time
const GEMINI_URL = key =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// After a Gemini rate-limit hit, skip it for a bit instead of retrying every
// message — the free-tier quota won't recover within seconds anyway.
const GEMINI_BACKOFF_MS = 60 * 1000;
let geminiBackoffUntil = 0;

async function buildSystemPrompt() {
  const [services, masters] = await Promise.all([db.getActiveServices(), db.getAllMasters()]);

  const servicesText = services
    .map(s => `- ${s.name}: ${s.price}₽, ${s.duration_minutes} мин`)
    .join('\n');
  const mastersText = masters.map(m => `- ${m.name}${m.description ? `: ${m.description}` : ''}`).join('\n');

  return (
    'Ты — консультант салона красоты в WhatsApp-чате. Отвечай кратко (2-4 предложения), дружелюбно, на русском.\n' +
    'Отвечай ТОЛЬКО на основе данных ниже. Если вопрос не про услуги/цены/мастеров/запись — вежливо скажи, ' +
    'что можешь помочь только с этим, и предложи написать "меню" для записи.\n' +
    'Не придумывай услуги, цены или мастеров, которых нет в списке.\n\n' +
    `Услуги:\n${servicesText || '(нет активных услуг)'}\n\n` +
    `Мастера:\n${mastersText || '(нет активных мастеров)'}`
  );
}

class RateLimitError extends Error {}

async function callGemini(apiKey, systemPrompt, userText) {
  const res = await fetch(GEMINI_URL(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
    }),
  });

  if (res.status === 429) throw new RateLimitError('Gemini rate limited');
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text().catch(() => '')}`);

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

async function callDeepSeek(apiKey, systemPrompt, userText) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
    }),
  });

  if (!res.ok) throw new Error(`DeepSeek error ${res.status}: ${await res.text().catch(() => '')}`);

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

// Provider fallback logic, independent of the FAQ system prompt — reused by
// the one-off chat-analysis script (src/scripts/analyzeChats.js) with its
// own prompt.
export async function askWithSystemPrompt(systemPrompt, userText) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  if (geminiKey && Date.now() > geminiBackoffUntil) {
    try {
      const answer = await callGemini(geminiKey, systemPrompt, userText);
      if (answer) return { answer, model: 'gemini' };
    } catch (err) {
      if (err instanceof RateLimitError) {
        geminiBackoffUntil = Date.now() + GEMINI_BACKOFF_MS;
      } else {
        console.error('Gemini error:', err.message);
      }
    }
  }

  if (deepseekKey) {
    try {
      const answer = await callDeepSeek(deepseekKey, systemPrompt, userText);
      if (answer) return { answer, model: 'deepseek' };
    } catch (err) {
      console.error('DeepSeek error:', err.message);
    }
  }

  return null;
}

// Returns the AI's answer, or null if no provider could answer (caller should
// fall back to a static message + main menu).
export async function askAI(userText) {
  const systemPrompt = await buildSystemPrompt();
  return askWithSystemPrompt(systemPrompt, userText);
}
