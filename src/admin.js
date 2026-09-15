import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './database.js';
import { sendText } from './whatsapp.js';
import { formatDateFull, getTimeSlotsForMaster } from './utils.js';
import * as waitlist from './waitlist.js';
import { COOKIE_NAME, createSessionCookieValue, verifySessionCookieValue, parseCookies } from './adminAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export const adminRouter = express.Router();

function setCookie(res, value, maxAgeMs) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; HttpOnly; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; SameSite=Lax${secure}`);
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionCookieValue(cookies[COOKIE_NAME])) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/admin/login');
}

adminRouter.get('/login', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-login.html'));
});

adminRouter.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'wrong_password' });
  }
  setCookie(res, createSessionCookieValue(), 12 * 60 * 60 * 1000);
  res.json({ ok: true });
});

adminRouter.post('/logout', (_req, res) => {
  setCookie(res, '', 0);
  res.json({ ok: true });
});

adminRouter.use(requireAuth);

adminRouter.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-dashboard.html'));
});

// ── Appointments ─────────────────────────────────────────────────────────
adminRouter.get('/api/appointments', async (req, res) => {
  const { date, dateFrom, dateTo, masterId, status } = req.query;
  const rows = await db.listAppointments({
    dateFrom: dateFrom || date || null,
    dateTo: dateTo || date || null,
    masterId: masterId ? parseInt(masterId, 10) : null,
    status: status || null,
  });
  res.json(rows);
});

adminRouter.post('/api/appointments/:id/cancel', async (req, res) => {
  const appt = await db.getAppointmentById(req.params.id);
  if (!appt || appt.status !== 'confirmed') return res.status(404).json({ error: 'not_found' });

  await db.cancelAppointment(appt.id);
  sendText(
    appt.user_id,
    `❌ Ваша запись отменена салоном\n\n` +
      `💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(String(appt.appointment_date).slice(0, 10))}\n` +
      `🕐 ${String(appt.start_time).slice(0, 5)} – ${String(appt.end_time).slice(0, 5)}\n\n` +
      `Для новой записи напишите "меню".`
  ).catch(() => {});
  waitlist.notifyNext(appt.master_id, String(appt.appointment_date).slice(0, 10)).catch(() => {});

  res.json({ ok: true });
});

adminRouter.post('/api/appointments/:id/reschedule', async (req, res) => {
  const { date, startTime, endTime } = req.body || {};
  if (!date || !startTime || !endTime) return res.status(400).json({ error: 'missing_fields' });

  const appt = await db.getAppointmentById(req.params.id);
  if (!appt || appt.status !== 'confirmed') return res.status(404).json({ error: 'not_found' });

  const available = await db.isSlotAvailable(appt.master_id, date, startTime, endTime, appt.id);
  if (!available) return res.status(409).json({ error: 'slot_taken' });

  await db.rescheduleAppointment(appt.id, { date, startTime, endTime });
  sendText(
    appt.user_id,
    `🔄 Ваша запись перенесена\n\n` +
      `💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(date)}\n🕐 ${startTime} – ${endTime}`
  ).catch(() => {});
  // Old slot just freed up too — offer it to whoever's waiting on that date.
  waitlist.notifyNext(appt.master_id, String(appt.appointment_date).slice(0, 10)).catch(() => {});

  res.json({ ok: true });
});

// ── Services ──────────────────────────────────────────────────────────────
adminRouter.get('/api/services', async (_req, res) => {
  res.json(await db.getAllServices());
});

adminRouter.post('/api/services', async (req, res) => {
  const { name, description, duration_minutes, price } = req.body || {};
  if (!name || !duration_minutes || price == null) return res.status(400).json({ error: 'missing_fields' });
  res.json(await db.createService({ name, description, durationMinutes: duration_minutes, price }));
});

adminRouter.put('/api/services/:id', async (req, res) => {
  const { name, description, duration_minutes, price, is_active } = req.body || {};
  if (!name || !duration_minutes || price == null) return res.status(400).json({ error: 'missing_fields' });
  res.json(
    await db.updateService(req.params.id, {
      name,
      description,
      durationMinutes: duration_minutes,
      price,
      isActive: is_active !== false,
    })
  );
});

// ── Masters (read-only, for dropdowns) ───────────────────────────────────
adminRouter.get('/api/masters', async (_req, res) => {
  res.json(await db.getAllMasters());
});

// ── Working hours ─────────────────────────────────────────────────────────
adminRouter.get('/api/working-hours', async (req, res) => {
  const masterId = parseInt(req.query.masterId, 10);
  if (!masterId) return res.status(400).json({ error: 'missing_master_id' });
  res.json(await db.getWorkingHoursForMaster(masterId));
});

adminRouter.put('/api/working-hours', async (req, res) => {
  const { masterId, dayOfWeek, startTime, endTime } = req.body || {};
  if (masterId == null || dayOfWeek == null) return res.status(400).json({ error: 'missing_fields' });

  if (!startTime || !endTime) {
    await db.deleteWorkingHour(masterId, dayOfWeek);
  } else {
    await db.upsertWorkingHour(masterId, dayOfWeek, startTime, endTime);
  }
  res.json({ ok: true });
});

// ── Service ↔ master assignment ──────────────────────────────────────────
adminRouter.get('/api/services/:id/masters', async (req, res) => {
  res.json(await db.getMastersForService(req.params.id));
});

adminRouter.put('/api/services/:id/masters', async (req, res) => {
  const { masterIds } = req.body || {};
  if (!Array.isArray(masterIds)) return res.status(400).json({ error: 'missing_fields' });
  await db.setServiceMasters(req.params.id, masterIds);
  res.json({ ok: true });
});

// ── Available slots (reschedule sheet + new-appointment sheet) ───────────
adminRouter.get('/api/available-slots', async (req, res) => {
  const { masterId, date, durationMinutes, excludeApptId } = req.query;
  if (!masterId || !date || !durationMinutes) return res.status(400).json({ error: 'missing_fields' });
  const slots = await getTimeSlotsForMaster(
    parseInt(masterId, 10),
    date,
    parseInt(durationMinutes, 10),
    excludeApptId ? parseInt(excludeApptId, 10) : null
  );
  res.json(slots);
});

// ── Create appointment (admin-created, e.g. phone booking / walk-in) ────
adminRouter.post('/api/appointments', async (req, res) => {
  const { phone, name, serviceId, masterId, date, startTime, endTime } = req.body || {};
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (!cleanPhone || !serviceId || !masterId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const masters = await db.getMastersForService(serviceId);
  if (!masters.some(m => m.id === Number(masterId))) {
    return res.status(400).json({ error: 'master_not_assigned' });
  }

  const available = await db.isSlotAvailable(masterId, date, startTime, endTime);
  if (!available) return res.status(409).json({ error: 'slot_taken' });

  await db.upsertUser({ id: cleanPhone, name: name || cleanPhone });
  const created = await db.createAppointment({ userId: cleanPhone, masterId, serviceId, date, startTime, endTime });
  const appt = await db.getAppointmentById(created.id);

  sendText(
    cleanPhone,
    `✅ Вас записали\n\n💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(date)}\n🕐 ${startTime} – ${endTime}`
  ).catch(() => {});

  res.json(appt);
});

adminRouter.use(express.static(PUBLIC_DIR));
