// The Instagram AI. Someone comments or writes in Direct with a question the
// keyword list has no answer for — this is what answers it, out of the
// preset blocks the owner keeps in the panel.
//
// Instagram for Astra is promotion for her courses, not bookings, so there
// are no tools here and nothing is ever written to the database: the model
// reads the presets and produces one message. Bookings stay on WhatsApp,
// where aiAgent.js has the schedule and a phone number to hang them on.
//
// No presets means no AI at all. An answer invented out of nothing about a
// course's price is worse than silence, and an empty knowledge base is
// exactly how a salon that never filled it in stays silent.
import { db } from './database.js';
import { askWithSystemPrompt } from './ai.js';

// The reply has to fit one Instagram message (2000), and a wall of text in
// Direct goes unread anyway. Asked for in the prompt, enforced by the caller.
const ANSWER_LIMIT = 1200;

// What the model says instead of answering when the message is not a
// question — "🔥", "класс", a tagged friend. A sentinel rather than a
// guess on our side: the model is already reading the text.
const SKIP = 'SKIP';

// A comment of two characters is not a question, and checking that here
// costs nothing where a request costs money and a second of latency.
const MIN_QUESTION_LENGTH = 6;

// Per person per day. Someone pasting the same question under thirty posts
// is the case this exists for, not a real client — nobody asks about one
// course twenty times in a day.
const DAILY_LIMIT = 20;

// Follow-ups in Direct ("а сколько длится?") only make sense with the
// previous turn in hand. In memory like aiAgent.js: a restart drops the
// small talk, and there is nothing here worth a table.
const HISTORY_MAX = 8;
const HISTORY_TTL_MS = 30 * 60 * 1000;

const histories = new Map();
const usage = new Map();

export const igAiEnabled = () => !!process.env.DEEPSEEK_API_KEY;

async function buildSystemPrompt() {
  const blocks = await db.getIgKnowledge();
  if (!blocks.length) return null;

  const knowledge = blocks.map(b => `## ${b.title}\n${b.body}`).join('\n\n');

  return (
    'Ты отвечаешь на вопросы в Instagram — в комментариях под постами и в директе.\n' +
    'Отвечай ТОЛЬКО на основе справки ниже. Не придумывай цены, даты, условия и обещания, ' +
    'которых в ней нет. Если в справке ответа нет — так и скажи и предложи написать в директ, ' +
    'чтобы уточнить у человека.\n' +
    `Пиши по-русски, дружелюбно, коротко: 2-5 предложений, не длиннее ${ANSWER_LIMIT} символов. ` +
    'Без markdown и без звёздочек — Instagram их не форматирует, они придут как есть.\n' +
    `Если сообщение не вопрос — эмодзи, «класс», «🔥», отметка друга, спам — ответь ровно: ${SKIP}\n\n` +
    `Справка:\n${knowledge}`
  );
}

function getHistory(id) {
  const h = histories.get(id);
  if (!h) return [];
  if (Date.now() - h.updatedAt > HISTORY_TTL_MS) {
    histories.delete(id);
    return [];
  }
  return h.messages;
}

function pushHistory(id, messages) {
  const kept = [...getHistory(id), ...messages].slice(-HISTORY_MAX);
  histories.set(id, { messages: kept, updatedAt: Date.now() });
}

// Counted per calendar day rather than in a rolling window: a counter that
// resets at midnight is one the salon can reason about when someone says
// the bot stopped answering them.
function overDailyLimit(id) {
  if (!id) return false;
  const today = new Date().toISOString().slice(0, 10);
  const seen = usage.get(id);
  const count = seen?.day === today ? seen.count : 0;
  if (count >= DAILY_LIMIT) return true;
  usage.set(id, { day: today, count: count + 1 });
  return false;
}

/**
 * The answer as one message, or null when the bot should stay silent —
 * no presets, no API key, not a question, over the daily limit, or DeepSeek
 * failed. Silence is always a valid outcome here: the keyword list already
 * had its turn, and a wrong answer under a public post costs more than none.
 *
 * `history` is on for Direct, where the person can actually follow up, and
 * off for comments, where they get exactly one message and there is nothing
 * to follow up on.
 */
export async function answerQuestion(userId, text, { history = false } = {}) {
  if (!igAiEnabled()) return null;

  const question = (text || '').trim();
  if (question.length < MIN_QUESTION_LENGTH) return null;
  if (overDailyLimit(userId)) {
    console.log(`[ig-ai] ${userId}: daily limit reached, staying silent`);
    return null;
  }

  const system = await buildSystemPrompt();
  if (!system) return null;

  const past = history ? getHistory(userId) : [];
  const result = await askWithSystemPrompt(system, question, past);
  const answer = result?.answer?.trim();
  if (!answer || answer === SKIP || answer.startsWith(SKIP)) return null;

  const trimmed = answer.slice(0, ANSWER_LIMIT);
  if (history) {
    pushHistory(userId, [
      { role: 'user', content: question },
      { role: 'assistant', content: trimmed },
    ]);
  }
  return trimmed;
}
