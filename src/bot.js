import 'dotenv/config';
import { db } from './database.js';
import { app } from './webhook.js';
import { startScheduler } from './scheduler.js';

const REQUIRED_ENV = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'DATABASE_URL',
  'ADMIN_PASSWORD',
  'ADMIN_COOKIE_SECRET',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required .env vars: ${missing.join(', ')}`);
  process.exit(1);
}

await db.init();
startScheduler();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WhatsApp bot webhook listening on port ${PORT}`);
});
