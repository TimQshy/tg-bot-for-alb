// Postgres-backed replacement for Baileys' useMultiFileAuthState: the linked
// device's creds + signal key store live in the wa_auth table instead of
// local files, so the session survives Railway redeploys (ephemeral
// filesystem — see IMPLEMENTATION_PLAN.md, "Деплой" section).
import { initAuthCreds, proto, BufferJSON } from '@whiskeysockets/baileys';
import { db } from './database.js';

async function readData(id) {
  const rows = await db.waAuthGetMany([id]);
  const raw = rows[id];
  if (!raw) return null;
  return JSON.parse(JSON.stringify(raw), BufferJSON.reviver);
}

function writeData(id, value) {
  return db.waAuthSet(id, JSON.parse(JSON.stringify(value, BufferJSON.replacer)));
}

export async function useDbAuthState() {
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const rows = await db.waAuthGetMany(ids.map(id => `${type}-${id}`));
          const data = {};
          for (const id of ids) {
            const raw = rows[`${type}-${id}`];
            if (!raw) continue;
            let value = JSON.parse(JSON.stringify(raw), BufferJSON.reviver);
            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const key = `${type}-${id}`;
              tasks.push(value ? writeData(key, value) : db.waAuthDelete(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}
