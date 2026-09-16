// One-off script: pulls accumulated client messages from the `messages`
// table (logged by webhook.js/whatsapp.js) and asks the AI to spot repeated
// questions + draft answers. Prints a draft to stdout — review and edit by
// hand, then turn approved pairs into src/faq.js. Not meant to run on a
// schedule (see IMPLEMENTATION_PLAN.md, эпик E).
//
// Usage: node src/scripts/analyzeChats.js
import 'dotenv/config';
import { db } from '../database.js';
import { askWithSystemPrompt } from '../ai.js';

const SYSTEM_PROMPT =
  'Тебе дан список вопросов клиентов салона красоты в WhatsApp. ' +
  'Найди повторяющиеся вопросы (перефразированные одинаково по смыслу — считай одним) ' +
  'и предложи короткий вежливый ответ на русском для каждого. ' +
  'Выведи результат в виде списка вида:\n' +
  'Вопрос: <паттерн>\nОтвет: <предлагаемый ответ>\n---\n' +
  'Не включай вопросы, которые встретились всего один раз и явно единичны (не будущий FAQ).';

async function main() {
  const texts = await db.getInboundMessageTexts();

  if (texts.length < 20) {
    console.log(`Только ${texts.length} входящих сообщений в БД — маловато для содержательного анализа. Подожди, пока накопится история, и запусти снова.`);
    return;
  }

  const userText = texts.map(t => `- ${t}`).join('\n');
  const result = await askWithSystemPrompt(SYSTEM_PROMPT, userText);

  if (!result) {
    console.error('DeepSeek недоступен — проверь DEEPSEEK_API_KEY в .env');
    process.exit(1);
  }

  console.log(`\n(модель: ${result.model}, сообщений проанализировано: ${texts.length})\n`);
  console.log(result.answer);
}

main().then(() => process.exit(0));
