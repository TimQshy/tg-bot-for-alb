// FAQ-scope AI consultant, DeepSeek only. No conversation history — each
// question is an independent request built from the current services/masters
// snapshot.
import { db } from './database.js';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

async function buildSystemPrompt() {
  const [services, masters] = await Promise.all([db.getActiveServices(), db.getActiveMasters()]);

  const servicesText = services
    .map(s => `- ${s.name}: ${s.price} сом, ${s.duration_minutes} мин`)
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

// Reused by the one-off chat-analysis script (src/scripts/analyzeChats.js)
// with its own prompt.
export async function askWithSystemPrompt(systemPrompt, userText) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
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
    const answer = data?.choices?.[0]?.message?.content?.trim();
    return answer ? { answer, model: 'deepseek' } : null;
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    return null;
  }
}

// Returns the AI's answer, or null if DeepSeek couldn't answer (caller should
// fall back to a static message + main menu).
export async function askAI(userText) {
  const systemPrompt = await buildSystemPrompt();
  return askWithSystemPrompt(systemPrompt, userText);
}
