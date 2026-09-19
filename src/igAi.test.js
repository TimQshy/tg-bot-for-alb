// The Instagram AI's guards, which are the part that decides whether the
// salon's Instagram stays quiet or says something wrong under a public post.
//
//   node --test --experimental-test-module-mocks src/igAi.test.js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let knowledge = [{ title: 'Цена курса', body: 'Курс стоит 12 000 сом.' }];
let answer = 'Курс стоит 12 000 сом, оплата частями.';
const asked = [];

mock.module('./database.js', {
  namedExports: { db: { getIgKnowledge: async () => knowledge } },
});
mock.module('./ai.js', {
  namedExports: {
    askWithSystemPrompt: async (system, userText, history) => {
      asked.push({ system, userText, history });
      return answer === null ? null : { answer, model: 'deepseek' };
    },
  },
});

process.env.DEEPSEEK_API_KEY = 'test-key';
const { answerQuestion } = await import('./igAi.js');

test('отвечает из пресетов и кладёт их в системный промпт', async () => {
  asked.length = 0;
  const reply = await answerQuestion('u1', 'Сколько стоит курс?');

  assert.equal(reply, 'Курс стоит 12 000 сом, оплата частями.');
  assert.match(asked[0].system, /Цена курса/);
  assert.match(asked[0].system, /12 000 сом/);
});

test('без пресетов молчит и не тратит запрос', async () => {
  const saved = knowledge;
  knowledge = [];
  asked.length = 0;

  assert.equal(await answerQuestion('u2', 'Сколько стоит курс?'), null);
  assert.equal(asked.length, 0);

  knowledge = saved;
});

test('SKIP от модели — это молчание, а не текст ответа', async () => {
  const saved = answer;
  answer = 'SKIP';

  assert.equal(await answerQuestion('u3', 'Огонь, класс!!'), null);

  answer = saved;
});

test('слишком короткое сообщение до модели не доходит', async () => {
  asked.length = 0;

  assert.equal(await answerQuestion('u4', '🔥'), null);
  assert.equal(asked.length, 0);
});

test('дневной лимит на человека закрывает поток', async () => {
  let last = null;
  for (let i = 0; i < 25; i++) last = await answerQuestion('spammer', 'Сколько стоит курс?');

  assert.equal(last, null, 'после лимита бот молчит');
  assert.ok(await answerQuestion('another', 'Сколько стоит курс?'), 'лимит считается по человеку');
});

test('история идёт в запрос только в директе', async () => {
  asked.length = 0;
  await answerQuestion('dm-user', 'Сколько стоит курс?', { history: true });
  await answerQuestion('dm-user', 'А сколько длится?', { history: true });

  assert.deepEqual(asked[0].history, []);
  assert.deepEqual(
    asked[1].history.map(m => m.role),
    ['user', 'assistant'],
    'второй вопрос видит предыдущий ход'
  );

  asked.length = 0;
  await answerQuestion('comment-user', 'Сколько стоит курс?');
  await answerQuestion('comment-user', 'А сколько длится?');
  assert.deepEqual(asked[1].history, [], 'на комментарий истории нет');
});
