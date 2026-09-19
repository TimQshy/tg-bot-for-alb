// splitText is what keeps Instagram from refusing a long auto-reply
// ("Length of param message[text] must be less than or equal to 2000"), so
// the one thing it must never do is hand back a chunk over the limit.
//
//   node --test src/utils.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitText } from './utils.js';

const LIMIT = 2000;
const strip = s => s.replace(/\s+/g, '');

test('короткий текст остаётся одним сообщением', () => {
  assert.deepEqual(splitText('Здравствуйте!', LIMIT), ['Здравствуйте!']);
  assert.deepEqual(splitText('', LIMIT), []);
  assert.deepEqual(splitText(null, LIMIT), []);
});

test('длинный текст режется по абзацам и ничего не теряет', () => {
  const text = Array.from({ length: 60 }, (_, i) => `Абзац ${i}. ${'я'.repeat(60)}`).join('\n\n');
  const parts = splitText(text, LIMIT);

  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= LIMIT, `часть длиной ${p.length}`);
  assert.equal(strip(parts.join('')), strip(text));
});

test('текст без единого пробела всё равно укладывается в лимит', () => {
  const parts = splitText('я'.repeat(4500), LIMIT);
  assert.deepEqual(parts.map(p => p.length), [LIMIT, LIMIT, 500]);
});

test('ровно по границе не режется', () => {
  assert.equal(splitText('я'.repeat(LIMIT), LIMIT).length, 1);
  assert.equal(splitText('я'.repeat(LIMIT + 1), LIMIT).length, 2);
});
