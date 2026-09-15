import 'dotenv/config';
import { db } from './database.js';
import { app, handleIncoming } from './webhook.js';
import { startScheduler } from './scheduler.js';
import { connectWhatsApp } from './whatsapp.js';

const REQUIRED_ENV = ['DATABASE_URL', 'ADMIN_PASSWORD', 'ADMIN_COOKIE_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required .env vars: ${missing.join(', ')}`);
  process.exit(1);
}

await db.init();
await connectWhatsApp(handleIncoming);
startScheduler();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WhatsApp bot listening on port ${PORT}`);
});
