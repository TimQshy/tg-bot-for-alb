import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './database.js';
import { sendAddress } from './booking.js';
import {
  SETTING_KEYS, HORIZON_KEY, HORIZON_MIN, HORIZON_MAX, getBookingHorizonDays,
} from './salonInfo.js';
import { sendText, getWaStatus } from './whatsapp.js';
import { formatDateFull, getDayOfWeek, splitText, newWalkInId } from './utils.js';
import {
  DEFAULT_STEP_MIN, findConflicts, getDaySchedule, getFreeSlots, previewSlots, serviceSlotOpts,
  validateIntervals,
} from './schedule.js';
import * as waitlist from './waitlist.js';
import { authorizeAdmin, clerk } from './adminAuth.js';
import { botEnabled, setBotEnabled } from './botState.js';
import {
  instagramEnabled, IG_MESSAGE_LIMIT, DEFAULT_CLOSED_DM_TEXT, CLOSED_DM_KEY, closedDmText,
} from './instagram.js';

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

function requireSystemAdmin(req, res, next) {
  if (!req.admin.isSystemAdmin) return res.status(403).json({ error: 'forbidden' });
  next();
}

// ── WhatsApp linked-device pairing (Baileys) ────────────────────────────
// Open to the salon as well: when the phone logs the device out — a new
// phone, a wipe, someone tidying up "Linked devices" — the salon is the only
// one holding the handset, and waiting for us to re-pair it means a dead bot
// in the meantime. The QR still links whoever scans it as the salon's bot,
// and scanning a fresh one drops the session that is running, so the screen
// says so in as many words.
adminRouter.get('/api/wa-status', (_req, res) => {
  const { status, qrDataUrl } = getWaStatus();
  res.json({ salon: process.env.SALON_SLUG, status, qrDataUrl });
});

// ── Emergency switch ─────────────────────────────────────────────────────
// Per salon, and only ours to flip: the salon turning its own bot off for
// the night is how clients end up with silence and no explanation. Anyone
// with access can *see* the state, so a quiet bot is never a mystery.
adminRouter.get('/api/bot-state', async (_req, res) => {
  res.json({ enabled: await botEnabled() });
});

adminRouter.put('/api/bot-state', requireSystemAdmin, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'missing_fields' });
  const enabled = await setBotEnabled(req.body.enabled);
  console.log(`[killswitch] bot ${enabled ? 'enabled' : 'disabled'} by ${req.admin.userId}`);
  res.json({ enabled });
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

// earliest_start/latest_start/blocks_day are the long-service rules: an empty
// string from the form means "no limit", which is NULL in the column.
function startWindow(body) {
  const time = v => (typeof v === 'string' && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null);
  return {
    earliestStart: time(body.earliest_start),
    latestStart: time(body.latest_start),
    blocksDay: body.blocks_day === true,
  };
}

adminRouter.post('/api/services', async (req, res) => {
  const { name, description, duration_minutes, slot_step_minutes, price } = req.body || {};
  if (!name || !duration_minutes || price == null) return res.status(400).json({ error: 'missing_fields' });
  res.json(await db.createService({
    name, description, durationMinutes: duration_minutes,
    slotStepMinutes: slot_step_minutes, price,
    ...startWindow(req.body || {}),
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
      ...startWindow(req.body || {}),
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

// ── Salon settings (address & co) ─────────────────────────────────────────
// Only the keys the bot knows how to use are stored, so the panel can't turn
// this into a dumping ground.
adminRouter.get('/api/settings', async (_req, res) => {
  const values = await db.getSettings();
  res.json({
    ...Object.fromEntries(SETTING_KEYS.map(k => [k, values[k] || ''])),
    [HORIZON_KEY]: await getBookingHorizonDays(),
  });
});

adminRouter.put('/api/settings', async (req, res) => {
  const body = req.body || {};
  const values = {};
  for (const key of SETTING_KEYS) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'string') return res.status(400).json({ error: 'bad_value' });
    values[key] = body[key].slice(0, 500);
  }

  // The horizon is a number with a range, not free text, so it is validated
  // here rather than silently clamped on read: a salon that types 900 should
  // be told, not quietly given 365.
  if (HORIZON_KEY in body) {
    const days = parseInt(body[HORIZON_KEY], 10);
    if (!Number.isFinite(days) || days < HORIZON_MIN || days > HORIZON_MAX) {
      return res.status(400).json({ error: 'bad_horizon' });
    }
    values[HORIZON_KEY] = String(days);
  }

  await db.setSettings(values);
  const saved = await db.getSettings();
  res.json({
    ...Object.fromEntries(SETTING_KEYS.map(k => [k, saved[k] || ''])),
    [HORIZON_KEY]: await getBookingHorizonDays(),
  });
});

// ── Instagram auto-replies ────────────────────────────────────────────────
// Only one salon has Instagram wired up; the others run the same image with
// IG_VERIFY_TOKEN unset and no webhook route at all. The panel asks first so
// it can say that instead of offering an editor whose texts nothing reads.
adminRouter.get('/api/ig-status', (_req, res) => {
  res.json({ enabled: instagramEnabled });
});

// What the bot answers publicly under the comment of someone whose account
// is closed — Direct is shut to us there, so this is the only thing that
// reaches them. Empty means "back to the default", not "say nothing": a
// silent bot under a comment asking for the price is worse than any wording.
adminRouter.get('/api/ig-closed-dm', async (_req, res) => {
  res.json({ text: await closedDmText(), default: DEFAULT_CLOSED_DM_TEXT });
});

adminRouter.put('/api/ig-closed-dm', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, IG_MESSAGE_LIMIT);
  await db.setIgConfig(CLOSED_DM_KEY, text || DEFAULT_CLOSED_DM_TEXT);
  res.json({ text: await closedDmText(), default: DEFAULT_CLOSED_DM_TEXT });
});

// The whole list is saved at once: order decides which keyword wins, so
// editing rows one by one would need a separate reorder call anyway.
adminRouter.get('/api/ig-replies', async (_req, res) => {
  res.json(await db.getIgReplies());
});

adminRouter.put('/api/ig-replies', async (req, res) => {
  const cleaned = cleanReplies(req.body?.replies, IG_MESSAGE_LIMIT);
  if (!cleaned) return res.status(400).json({ error: 'missing_fields' });
  await db.saveIgReplies(cleaned);
  res.json(await db.getIgReplies());
});

// ── What the Instagram AI answers from ────────────────────────────────────
// Free-form named blocks — «Цена курса», «Программа», «Как оплатить». The
// panel reuses the auto-reply editor, so the wire shape is that editor's
// keyword/reply pair and the mapping to title/body lives here.
adminRouter.get('/api/ig-knowledge', async (_req, res) => {
  res.json((await db.getIgKnowledge()).map(b => ({ keyword: b.title, reply: b.body })));
});

adminRouter.put('/api/ig-knowledge', async (req, res) => {
  const cleaned = cleanReplies(req.body?.replies);
  if (!cleaned) return res.status(400).json({ error: 'missing_fields' });
  await db.saveIgKnowledge(cleaned.map(r => ({ title: r.keyword, body: r.parts.join('\n\n') })));
  res.json((await db.getIgKnowledge()).map(b => ({ keyword: b.title, reply: b.body })));
});

// ── WhatsApp auto-replies ─────────────────────────────────────────────────
// Same editor as Instagram's, but these texts answer WhatsApp clients before
// the AI agent sees the message — see handleIncoming in webhook.js.
adminRouter.get('/api/wa-replies', async (_req, res) => {
  res.json(await db.getWaReplies());
});

adminRouter.put('/api/wa-replies', async (req, res) => {
  const cleaned = cleanReplies(req.body?.replies);
  if (!cleaned) return res.status(400).json({ error: 'missing_fields' });
  await db.saveWaReplies(cleaned);
  res.json(await db.getWaReplies());
});

// Half-filled rows are dropped rather than rejected: the panel warns about
// them before saving, and a row with no reply would answer with an empty
// message. null means the body wasn't a list at all.
//
// An answer is a chain of messages the bot sends one after another. Older
// panels (and the WhatsApp editor) send a single `reply` string instead, so
// both shapes are accepted. `limit` caps one message: over it the text is
// split here as a safety net, because a message Instagram refuses is worse
// than one the owner didn't choose the break point for — the panel asks for
// the break points first, so this normally has nothing to do.
function cleanReplies(replies, limit = 0) {
  if (!Array.isArray(replies)) return null;
  return replies
    .map(r => {
      const raw = Array.isArray(r.parts) ? r.parts : [r.reply];
      const parts = raw
        .map(p => String(p || '').trim())
        .filter(Boolean)
        .flatMap(p => (limit ? splitText(p, limit) : [p]));
      return { keyword: String(r.keyword || '').trim(), parts };
    })
    .filter(r => r.keyword && r.parts.length);
}

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
    getFreeSlots(id, date, durationMin, serviceSlotOpts(service, { includeBusy: true })),
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
  const { masterId, date, durationMinutes, stepMinutes, excludeApptId, serviceId } = req.query;
  if (!masterId || !date || !durationMinutes) return res.status(400).json({ error: 'missing_fields' });

  // With serviceId the service's own rules apply, exactly as they do in
  // WhatsApp; without it the panel still gets the plain duration-based list.
  const service = serviceId ? await db.getService(parseInt(serviceId, 10)) : null;
  const slots = await getFreeSlots(
    parseInt(masterId, 10),
    date,
    parseInt(durationMinutes, 10),
    serviceSlotOpts(service, {
      stepMin: stepMinutes ? parseInt(stepMinutes, 10) : DEFAULT_STEP_MIN,
      excludeApptId: excludeApptId ? parseInt(excludeApptId, 10) : null,
    })
  );
  res.json(slots);
});

// ── Create appointment (admin-created, e.g. phone booking / walk-in) ────
// A phone number is optional: someone standing at the counter may not want to
// leave one, and the salon still needs the slot held. Without it the client
// gets a `walkin:` id instead of a number — a users row that exists, is
// linked to the appointment, and that nothing ever tries to message.
adminRouter.post('/api/appointments', async (req, res) => {
  const { phone, name, serviceId, masterId, date, startTime, endTime } = req.body || {};
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!serviceId || !masterId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  // With no phone the name is the only thing left to tell one client from
  // another in the day's list, so it stops being optional.
  if (!cleanPhone && !cleanName) return res.status(400).json({ error: 'name_required' });

  const masters = await db.getMastersForService(serviceId);
  if (!masters.some(m => m.id === Number(masterId))) {
    return res.status(400).json({ error: 'master_not_assigned' });
  }

  const available = await db.isSlotAvailable(masterId, date, startTime, endTime);
  if (!available) return res.status(409).json({ error: 'slot_taken' });

  const userId = cleanPhone || newWalkInId();
  await db.upsertUser({ id: userId, name: cleanName || cleanPhone });
  const created = await db.createAppointment({ userId, masterId, serviceId, date, startTime, endTime });
  const appt = await db.getAppointmentById(created.id);

  // sendText drops walk-in ids on its own, so this needs no branch of its own.
  sendText(
    userId,
    `✅ Вас записали\n\n💅 ${appt.service_name}\n👩 ${appt.master_name}\n` +
      `📅 ${formatDateFull(date)}\n🕐 ${startTime} – ${endTime}`
  ).then(() => sendAddress(userId)).catch(() => {});

  res.json(appt);
});

adminRouter.use(express.static(PUBLIC_DIR));
