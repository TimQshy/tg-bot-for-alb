import 'dotenv/config';
import { Telegraf, Scenes, session } from 'telegraf';
import { db } from './database.js';
import { bookingScene } from './scenes/booking.js';
import { addMasterScene } from './scenes/admin/addMaster.js';
import { addServiceScene } from './scenes/admin/addService.js';
import { setHoursScene } from './scenes/admin/setHours.js';
import { startHandler } from './handlers/start.js';
import { myBookingsHandler, cancelApptAction, confirmCancelAction } from './handlers/myBookings.js';
import { adminCommand, adminActions, isAdmin } from './handlers/admin.js';
import { startReminderService } from './services/reminders.js';

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN is required in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// ── Middleware ──────────────────────────────────────────────────────────────
bot.use(session());

const stage = new Scenes.Stage([bookingScene, addMasterScene, addServiceScene, setHoursScene]);
bot.use(stage.middleware());

// ── Commands ────────────────────────────────────────────────────────────────
bot.start(startHandler);
bot.command('mybookings', myBookingsHandler);
bot.command('admin', adminCommand);

// ── Client actions ──────────────────────────────────────────────────────────
bot.action('book', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.scene.enter('booking');
});
bot.action('my_bookings',    myBookingsHandler);
bot.action('main_menu',      startHandler);
bot.action(/^cancel_appt:/,  cancelApptAction);
bot.action(/^confirm_cancel:/, confirmCancelAction);

// ── Admin actions ───────────────────────────────────────────────────────────
bot.action(/^admin:/, adminActions);

// ── Error handler ───────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`[${ctx.updateType}] Error:`, err.message);
  ctx.reply('Что-то пошло не так. Попробуйте /start').catch(() => {});
});

// ── Start ───────────────────────────────────────────────────────────────────
await db.init();
startReminderService(bot);

bot.launch({ dropPendingUpdates: true });
console.log('Bot is running...');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
