import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './database.js';
import { sendText, getWaStatus } from './whatsapp.js';
import { formatDateFull, getDayOfWeek } from './utils.js';
import {
  DEFAULT_STEP_MIN, findConflicts, getDaySchedule, getFreeSlots, previewSlots, validateIntervals,
} from './schedule.js';
import * as waitlist from './waitlist.js';
import { authorizeAdmin, clerk } from './adminAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export const adminRouter = express.Router();

async function requireAuth(req, res, next) {
  const auth = await authorizeAdmin(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  req.admin = auth;
  next();
}

// The dashboard shell carries no salon data — Clerk gates the UI in the
// browser and requireAuth gates every /api route below, so serving the
// markup itself unauthenticated is what lets the page sign the user in.
adminRouter.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-dashboard.html'));
});

adminRouter.use('/api', requireAuth);

// ── WhatsApp linked-device pairing (Baileys) ────────────────────────────
// System admins only. Linking the number is an onboarding step we run for
// the salon, and the QR is dangerous in the wrong hands twice over: whoever
// scans it links *their* WhatsApp as the salon's bot, and a salon owner
// re-linking their own device silently kills the existing session.
function requireSystemAdmin(req, res, next) {
  if (!req.admin.isSystemAdmin) return res.status(403).json({ error: 'forbidden' });
  next();
}

adminRouter.get('/api/wa-status', requireSystemAdmin, (_req, res) => {
  const { status, qrDataUrl } = getWaStatus();
  res.json({ salon: process.env.SALON_SLUG, status, qrDataUrl });
});

// ── Access control (Clerk) ───────────────────────────────────────────────
// Instance-wide, not per salon — any container can serve it, they all hold
// the same CLERK_SECRET_KEY. Access is granted through public metadata:
// { role: 'system_admin' } or { salons: [...] }.
function describeAccess(metadata) {
  const meta = metadata || {};
  if (meta.role === 'system_admin') return { role: 'system_admin', salons: [] };
  return { role: 'salon_owner', salons: Array.isArray(meta.salons) ? meta.salons : [] };
}

adminRouter.get('/api/access', requireSystemAdmin, async (_req, res) => {
  const [users, invitations] = await Promise.all([
    clerk().users.getUserList({ limit: 100 }),
    clerk().invitations.getInvitationList({ status: 'pending', limit: 100 }),
  ]);

  res.json({
    users: users.data.map(u => ({
      id: u.id,
      email: u.primaryEmailAddress?.emailAddress || u.emailAddresses[0]?.emailAddress || null,
      ...describeAccess(u.publicMetadata),
    })),
    invitations: invitations.data.map(i => ({
      id: i.id,
      email: i.emailAddress,
      ...describeAccess(i.publicMetadata),
    })),
  });
});

adminRouter.post('/api/access/invitations', requireSystemAdmin, async (req, res) => {
  const { email, role, salons } = req.body || {};
  if (!email) return res.status(400).json({ error: 'missing_email' });

  const publicMetadata = role === 'system_admin'
    ? { role: 'system_admin' }
    : { salons: Array.isArray(salons) ? salons : [] };

  if (publicMetadata.salons && !publicMetadata.salons.length) {
    return res.status(400).json({ error: 'missing_salon' });
  }

  try {
    const inv = await clerk().invitations.createInvitation({
      emailAddress: email,
      publicMetadata,
      ignoreExisting: false,
    });
    res.json({ id: inv.id, email: inv.emailAddress });
  } catch (err) {
    // Clerk rejects duplicates and addresses that already have an account —
    // both are things the admin should see verbatim rather than "failed".
    const detail = err?.errors?.[0];
    res.status(400).json({ error: detail?.code || 'invitation_failed', message: detail?.longMessage || detail?.message });
  }
});

// Sign-up is open, so people register themselves and land with no access at
// all — this is where they get pointed at a salon.
adminRouter.patch('/api/access/users/:id', requireSystemAdmin, async (req, res) => {
  if (req.params.id === req.admin.userId) {
    return res.status(400).json({ error: 'cannot_change_self', message: 'Свои права менять нельзя — так можно закрыть себе вход в панель' });
  }

  const { role, salons } = req.body || {};
  // Clerk merges metadata key by key, so the key we are not setting has to
  // be nulled explicitly or the old value survives.
  const publicMetadata = role === 'system_admin'
    ? { role: 'system_admin', salons: null }
    : { role: null, salons: Array.isArray(salons) ? salons : [] };

  try {
    await clerk().users.updateUserMetadata(req.params.id, { publicMetadata });
    res.json({ ok: true });
  } catch (err) {
    const detail = err?.errors?.[0];
    res.status(400).json({ error: detail?.code || 'update_failed', message: detail?.longMessage || detail?.message });
  }
});

adminRouter.post('/api/access/invitations/:id/revoke', requireSystemAdmin, async (req, res) => {
  try {
    await clerk().invitations.revokeInvitation(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const detail = err?.errors?.[0];
    res.status(400).json({ error: detail?.code || 'revoke_failed', message: detail?.longMessage || detail?.message });
  }
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
  const { name, description, duration_minutes, slot_step_minutes, price } = req.body || {};
  if (!name || !duration_minutes || price == null) return res.status(400).json({ error: 'missing_fields' });
  res.json(await db.createService({
    name, description, durationMinutes: duration_minutes,
    slotStepMinutes: slot_step_minutes, price,
  }));
});

// Deleting is refused as soon as anything references the row — the counts
// go back so the panel can say what is holding it and offer to hide it
// instead. See db.deleteService / db.deleteMaster.
function inUseResponse(res, kind, usage) {
  const total = usage.appointments + usage.waitlist;
  const word = total % 10 === 1 && total % 100 !== 11 ? 'записи' : 'записей';
  return res.status(409).json({
    error: 'in_use',
    appointments: usage.appointments,
    waitlist: usage.waitlist,
    message: kind === 'service'
      ? `Услуга уже стоит в ${total} ${word} — её можно только скрыть, тогда история сохранится.`
      : `Мастер уже стоит в ${total} ${word} — его можно только отключить, тогда история сохранится.`,
  });
}

adminRouter.put('/api/services/:id', async (req, res) => {
  const { name, description, duration_minutes, slot_step_minutes, price, is_active } = req.body || {};
  if (!name || !duration_minutes || price == null) return res.status(400).json({ error: 'missing_fields' });
  res.json(
    await db.updateService(req.params.id, {
      name,
      description,
      durationMinutes: duration_minutes,
      slotStepMinutes: slot_step_minutes,
      price,
      isActive: is_active !== false,
    })
  );
});

adminRouter.delete('/api/services/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await db.getService(id))) return res.status(404).json({ error: 'not_found' });

  const result = await db.deleteService(id);
  if (!result.deleted) return inUseResponse(res, 'service', result);
  res.json({ ok: true });
});

// ── Instagram auto-replies ────────────────────────────────────────────────
// The whole list is saved at once: order decides which keyword wins, so
// editing rows one by one would need a separate reorder call anyway.
adminRouter.get('/api/ig-replies', async (_req, res) => {
  res.json(await db.getIgReplies());
});

adminRouter.put('/api/ig-replies', async (req, res) => {
  const replies = Array.isArray(req.body?.replies) ? req.body.replies : null;
  if (!replies) return res.status(400).json({ error: 'missing_fields' });
  const cleaned = replies
    .map(r => ({ keyword: String(r.keyword || '').trim(), reply: String(r.reply || '').trim() }))
    .filter(r => r.keyword && r.reply);
  await db.saveIgReplies(cleaned);
  res.json(await db.getIgReplies());
});

// ── Masters ───────────────────────────────────────────────────────────────
// A master who has never been booked can be deleted outright; once there are
// appointments behind them, only switching them off is possible — see
// db.deleteMaster.
adminRouter.get('/api/masters', async (_req, res) => {
  res.json(await db.listMasters());
});

adminRouter.post('/api/masters', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing_fields' });
  res.json(await db.createMaster({ name, description: req.body?.description }));
});

adminRouter.put('/api/masters/:id', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing_fields' });

  const master = await db.updateMaster(req.params.id, {
    name,
    description: req.body?.description,
    isActive: req.body?.is_active !== false,
  });
  if (!master) return res.status(404).json({ error: 'not_found' });
  res.json(master);
});

adminRouter.delete('/api/masters/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await db.getMaster(id))) return res.status(404).json({ error: 'not_found' });

  const result = await db.deleteMaster(id);
  if (!result.deleted) return inUseResponse(res, 'master', result);
  res.json({ ok: true });
});

// ── Schedule: weekly template ─────────────────────────────────────────────
// Editing the template never touches dates that carry an override — that is
// the whole point of the two levels, so there is no cascade here.
adminRouter.get('/api/schedule/template', async (req, res) => {
  const masterId = parseInt(req.query.masterId, 10);
  if (!masterId) return res.status(400).json({ error: 'missing_master_id' });
  res.json(await db.getScheduleTemplate(masterId));
});

adminRouter.put('/api/schedule/template', async (req, res) => {
  const { masterId, weekday, isWorking } = req.body || {};
  if (!masterId || weekday == null) return res.status(400).json({ error: 'missing_fields' });

  if (!isWorking) {
    await db.upsertTemplateDay(masterId, weekday, false, []);
    return res.json({ ok: true });
  }

  let intervals;
  try {
    intervals = validateIntervals(req.body?.intervals);
  } catch (err) {
    return res.status(400).json({ error: err.code || 'invalid_intervals', message: err.message });
  }
  res.json(await db.upsertTemplateDay(masterId, weekday, true, intervals));
});

// ── Schedule: per-date overrides ─────────────────────────────────────────
adminRouter.get('/api/schedule/overrides', async (req, res) => {
  const { masterId, from, to } = req.query;
  if (!masterId || !from || !to) return res.status(400).json({ error: 'missing_fields' });
  res.json(await db.listOverrides(parseInt(masterId, 10), from, to));
});

// The effective day: what governs this date, the slots it yields, and any
// appointment those hours would cut across.
adminRouter.get('/api/schedule/day', async (req, res) => {
  const { masterId, date, serviceId } = req.query;
  if (!masterId || !date) return res.status(400).json({ error: 'missing_fields' });

  const id = parseInt(masterId, 10);
  const day = await getDaySchedule(id, date);
  const service = serviceId ? await db.getService(parseInt(serviceId, 10)) : null;
  const durationMin = service?.duration_minutes || 60;

  const [slots, conflicts] = await Promise.all([
    getFreeSlots(id, date, durationMin, {
      stepMin: service?.slot_step_minutes || DEFAULT_STEP_MIN,
      includeBusy: true,
    }),
    findConflicts(id, date, day.intervals),
  ]);

  res.json({ ...day, date, slots, conflicts });
});

// Saving is deliberately not blocked by conflicts: the salon knows it has a
// client booked into the hour it is taking off, and cancelling their
// appointment behind their back is worse than flagging it.
adminRouter.put('/api/schedule/override', async (req, res) => {
  const { masterId, date, kind, repeatWeekly } = req.body || {};
  if (!masterId || !date || !['custom', 'dayoff'].includes(kind)) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  let intervals = [];
  if (kind === 'custom') {
    try {
      intervals = validateIntervals(req.body?.intervals);
    } catch (err) {
      return res.status(400).json({ error: err.code || 'invalid_intervals', message: err.message });
    }
  }

  await db.upsertOverride(masterId, date, kind, intervals);

  // "Repeat every <weekday>" moves the same hours into the standing week.
  // Other dates that already carry their own override keep it.
  if (repeatWeekly) {
    await db.upsertTemplateDay(masterId, getDayOfWeek(date), kind === 'custom', intervals);
  }

  res.json({ ok: true, conflicts: await findConflicts(masterId, date, intervals) });
});

// Back to the template — the row goes away, so the date follows the weekly
// schedule again, including any later edit to it.
adminRouter.delete('/api/schedule/override', async (req, res) => {
  const { masterId, date } = req.query;
  if (!masterId || !date) return res.status(400).json({ error: 'missing_fields' });
  await db.deleteOverride(parseInt(masterId, 10), date);
  res.json({ ok: true });
});

// Slots for intervals the salon has typed but not yet saved, so the editor
// can show what it is about to do.
adminRouter.post('/api/schedule/preview', async (req, res) => {
  const { masterId, date, kind, serviceId } = req.body || {};
  if (!masterId || !date) return res.status(400).json({ error: 'missing_fields' });

  let intervals = [];
  if (kind !== 'dayoff') {
    try {
      intervals = validateIntervals(req.body?.intervals);
    } catch (err) {
      return res.status(400).json({ error: err.code || 'invalid_intervals', message: err.message });
    }
  }

  const service = serviceId ? await db.getService(parseInt(serviceId, 10)) : null;
  const slots = await previewSlots(masterId, date, intervals, {
    durationMin: service?.duration_minutes,
    stepMin: service?.slot_step_minutes,
  });

  res.json({ slots, conflicts: await findConflicts(masterId, date, intervals) });
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
  const { masterId, date, durationMinutes, stepMinutes, excludeApptId } = req.query;
  if (!masterId || !date || !durationMinutes) return res.status(400).json({ error: 'missing_fields' });
  const slots = await getFreeSlots(
    parseInt(masterId, 10),
    date,
    parseInt(durationMinutes, 10),
    {
      stepMin: stepMinutes ? parseInt(stepMinutes, 10) : DEFAULT_STEP_MIN,
      excludeApptId: excludeApptId ? parseInt(excludeApptId, 10) : null,
    }
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
