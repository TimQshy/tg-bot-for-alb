// FAQ-scope AI consultant, DeepSeek only. No conversation history — each
// question is an independent request built from the current services/masters
// snapshot.
import { db } from './database.js';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

async function buildSystemPrompt() {
  const [services, masters] = await Promise.all([db.getActiveServices(), db.getActiveMasters()]);

  const servicesText = services
    .map(s => `- ${s.name}: от ${s.price} сом, ${s.duration_minutes} мин`)
    .join('\n');
  const mastersText = masters.map(m => `- ${m.name}${m.description ? `: ${m.description}` : ''}`).join('\n');

  return (
    'Ты — консультант салона красоты в WhatsApp-чате. Отвечай кратко (2-4 предложения), дружелюбно, на русском.\n' +
    'Отвечай ТОЛЬКО на основе данных ниже. Если вопрос не про услуги/цены/мастеров/запись — вежливо скажи, ' +
    'что можешь помочь только с этим, и предложи написать "меню" для записи.\n' +
    'Не придумывай услуги, цены или мастеров, которых нет в списке.\n' +
    'Все цены — ориентировочные и указаны «от». Итоговая стоимость зависит от длины и густоты волос, ' +
    'их состояния и количества израсходованных материалов. Когда называешь цену, всегда говори «от X сом» ' +
    'и коротко поясняй, от чего зависит итог. Точную сумму мастер называет на консультации перед началом работы — ' +
    'предлагай записаться или прийти на консультацию, если клиент хочет точную цену.\n\n' +
    `Услуги:\n${servicesText || '(нет активных услуг)'}\n\n` +
    `Мастера:\n${mastersText || '(нет активных мастеров)'}`
  );
}

// One raw call. Returns the assistant message as the API gave it — content
// and, when the model wants to use a tool, tool_calls — so the agent loop in
// aiAgent.js can drive several rounds. Throws; callers decide what a failure
// means for the client.
export async function chat({ messages, tools = null, temperature = 0.3 }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    }),
  });

  if (!res.ok) throw new Error(`DeepSeek error ${res.status}: ${await res.text().catch(() => '')}`);

  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error('DeepSeek returned no message');
  return message;
}

// Reused by the one-off chat-analysis script (src/scripts/analyzeChats.js)
// and by the Instagram AI (src/igAi.js), both with their own prompts.
// `history` is earlier user/assistant turns; empty means a one-shot question.
export async function askWithSystemPrompt(systemPrompt, userText, history = []) {
  if (!process.env.DEEPSEEK_API_KEY) return null;

  try {
    const message = await chat({
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userText },
      ],
    });
    const answer = message.content?.trim();
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
