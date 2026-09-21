import pg from 'pg';
const { Pool } = pg;

// DATE columns: keep as raw "YYYY-MM-DD" string, not a parsed JS Date.
// The rest of the codebase treats appointment dates as plain date strings
// (session state, formatDateFull, etc.) — a JS Date here shifts by timezone
// and breaks that everywhere it's re-stringified.
pg.types.setTypeParser(1082, val => val);

// SSL only when the URL asks for it. On the VPS Postgres is a compose
// service with no `ports:`, reachable only on the private network and not
// speaking TLS at all — assuming SSL for every non-localhost host made every
// salon crash-loop with "The server does not support SSL connections".
const wantsSsl = /[?&]sslmode=(require|verify-ca|verify-full)\b/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: wantsSsl ? { rejectUnauthorized: false } : false,
});

const TZ = process.env.TIMEZONE || 'Europe/Moscow';

pool.on('connect', client => {
  client.query(`SET timezone = '${TZ}'`);
});

// user id = WhatsApp phone number (E.164 digits, no '+'), e.g. "79161234567"
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS masters (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  price NUMERIC(10,2) NOT NULL,
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS master_services (
  master_id INTEGER REFERENCES masters(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
);

CREATE TABLE IF NOT EXISTS working_hours (
  id SERIAL PRIMARY KEY,
  master_id INTEGER REFERENCES masters(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  UNIQUE (master_id, day_of_week)
);

-- Two-level schedule. schedule_template is the standing week; an override
-- replaces it outright for one date. Deleting the override — not copying
-- the template into it — is what "back to the template" means, so a later
-- template edit reaches that date again.
--
-- weekday is 0=Mon … 6=Sun, matching getDayOfWeek() in src/utils.js, not
-- JS getDay(). intervals is
--   [{"from":"12:00","to":"19:00","breaks":[{"from":"16:00","to":"17:00","note":"личное"}]}]
CREATE TABLE IF NOT EXISTS schedule_template (
  id SERIAL PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  is_working BOOLEAN NOT NULL DEFAULT true,
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (master_id, weekday)
);

CREATE TABLE IF NOT EXISTS schedule_override (
  id SERIAL PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('custom', 'dayoff')),
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (master_id, date)
);

CREATE INDEX IF NOT EXISTS idx_override_master_date ON schedule_override(master_id, date);

-- How often a booking may start, as opposed to how long it runs: a 20-minute
-- haircut on a 30-minute step wastes 10 minutes of every gap.
ALTER TABLE services ADD COLUMN IF NOT EXISTS slot_step_minutes INTEGER NOT NULL DEFAULT 30;

-- Long services (сложное окрашивание) are only worth starting in the morning
-- and take the master for the rest of the day: earliest_start/latest_start
-- bound when the service may begin, blocks_day keeps every other booking off
-- that master on a day one of these is booked. NULL/false = no restriction,
-- which is what every existing service keeps.
ALTER TABLE services ADD COLUMN IF NOT EXISTS earliest_start TIME;
ALTER TABLE services ADD COLUMN IF NOT EXISTS latest_start TIME;
ALTER TABLE services ADD COLUMN IF NOT EXISTS blocks_day BOOLEAN NOT NULL DEFAULT false;

-- Human takeover: while this is in the future the bot stays silent in that
-- chat, so an admin answering the client by hand isn't talked over by the
-- FSM. Set from whatsapp.js when an outgoing message appears that the bot
-- itself didn't send. A column rather than an in-memory map so a redeploy
-- mid-conversation doesn't wake the bot back up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_paused_until TIMESTAMPTZ;

-- One-shot carry-over from the single-interval working_hours table. Guarded
-- on the template being empty rather than ON CONFLICT, or a day the salon
-- has since switched off would come back on the next boot.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schedule_template) THEN
    INSERT INTO schedule_template (master_id, weekday, is_working, intervals)
    SELECT master_id, day_of_week, true,
           jsonb_build_array(jsonb_build_object(
             'from', to_char(start_time, 'HH24:MI'),
             'to',   to_char(end_time,   'HH24:MI'),
             'breaks', '[]'::jsonb))
    FROM working_hours;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  master_id INTEGER REFERENCES masters(id),
  service_id INTEGER REFERENCES services(id),
  appointment_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  reminder_24h_sent BOOLEAN NOT NULL DEFAULT false,
  reminder_2h_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appt_date   ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appt_user   ON appointments(user_id);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);

-- Inbound/outbound WhatsApp message log — feeds the FAQ analysis script.
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- Waitlist: one row per person waiting for a freed-up slot with a given
-- master on a given date. FIFO by created_at within (master_id, desired_date).
CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  master_id INTEGER REFERENCES masters(id),
  service_id INTEGER REFERENCES services(id),
  desired_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'offered', 'booked', 'expired', 'cancelled')),
  offered_start_time TIME,
  offered_end_time TIME,
  offered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_lookup ON waitlist(master_id, desired_date, status);

-- Baileys (WhatsApp Web protocol) session: creds + signal key store, keyed
-- by a composite id like "creds" or "app-state-sync-key-<id>". DB-backed
-- instead of local files so the linked-device session survives redeploys
-- (Railway containers are ephemeral — see IMPLEMENTATION_PLAN.md).
CREATE TABLE IF NOT EXISTS wa_auth (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Instagram auto-replies: first row whose keyword occurs in the incoming
-- text wins, so ordering matters. A keyword of '*' matches anything and is
-- meant to sit last as the catch-all.
CREATE TABLE IF NOT EXISTS ig_replies (
  id SERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  reply TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- WhatsApp auto-replies: same shape and same first-match-wins rule as
-- ig_replies, but read by webhook.js before the AI agent gets the message —
-- a matching keyword answers with a fixed text and the agent stays out.
CREATE TABLE IF NOT EXISTS wa_replies (
  id SERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  reply TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- One answer can be a chain of messages sent one after another: Instagram
-- refuses any single message longer than 2000 characters, so a long text is
-- split by hand in the panel and the bot just walks the chain in order.
-- The reply column keeps the whole thing joined so the old single-text
-- readers (and anyone looking at the table) still see the full answer.
ALTER TABLE ig_replies ADD COLUMN IF NOT EXISTS parts JSONB;
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS parts JSONB;

-- What the Instagram AI knows. Free-form named blocks the owner adds in the
-- panel — «Цена курса», «Программа», «Как оплатить» — pasted into the system
-- prompt in this order. Deliberately not the salon settings table:
-- Instagram is about the courses, and the manicure address has no business
-- turning up in an answer about a course. No rows at all: the AI stays off.
CREATE TABLE IF NOT EXISTS ig_knowledge (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- Delivered webhook events, so Meta's retries don't answer the same comment
-- twice. Ids are prefixed by kind ("c:<comment id>", "m:<message id>").
CREATE TABLE IF NOT EXISTS ig_events (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Salon-level text the owner edits in the panel and the bot quotes verbatim:
-- the address, how to find the door, a map link. Key/value because these are
-- free-form strings with no behaviour attached — a missing row means the bot
-- simply doesn't mention it.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Long-lived Instagram tokens expire after 60 days and are refreshed in
-- place, so they cannot live in the environment.
CREATE TABLE IF NOT EXISTS ig_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
`;

// Shared by the ig_replies / wa_replies helpers on db. Callers pass one of
// those two literals — nothing here comes from a request.
async function listReplies(table) {
  const { rows } = await pool.query(
    `SELECT * FROM ${table} WHERE is_active=true ORDER BY position, id`
  );
  // Rows saved before the chain existed have no parts — their single text is
  // the whole chain, so callers never have to care which era a row is from.
  return rows.map(r => ({ ...r, parts: replyParts(r) }));
}

function replyParts(row) {
  const parts = Array.isArray(row.parts)
    ? row.parts.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
    : [];
  return parts.length ? parts : [row.reply];
}

// The whole list is rewritten at once: order decides which keyword wins, so
// row-by-row edits would need a separate reorder call anyway.
async function replaceReplies(table, replies) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${table}`);
    for (const [i, r] of replies.entries()) {
      const parts = r.parts?.length ? r.parts : [r.reply];
      await client.query(
        `INSERT INTO ${table} (keyword, reply, position, parts) VALUES ($1,$2,$3,$4)`,
        [r.keyword, parts.join('\n\n'), i, JSON.stringify(parts)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const db = {
  async init() {
    await pool.query(SCHEMA);
    console.log('Database ready');
  },

  // name is COALESCEd so a message that arrives without a WhatsApp profile
  // name doesn't overwrite a name the client typed to the AI agent.
  async upsertUser({ id, name }) {
    await pool.query(
      `INSERT INTO users (id, name)
       VALUES ($1, COALESCE($2,$1))
       ON CONFLICT (id) DO UPDATE SET name = COALESCE($2, users.name)`,
      [id, name || null]
    );
  },

  async getUser(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
    return rows[0] || null;
  },

  // Used when the client tells the AI agent their name: fills it in only
  // while we're still calling them by their phone number, so a real WhatsApp
  // profile name is never replaced by something misheard in chat.
  async setUserNameIfUnknown(id, name) {
    await pool.query(
      `INSERT INTO users (id, name) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET name=$2 WHERE users.name = users.id`,
      [id, name]
    );
  },

  // ── Human takeover ────────────────────────────────────────────────────────
  // Upsert rather than UPDATE: the admin may well answer a number that has
  // never written to the bot, so there's no users row yet. name is only set
  // on insert — an existing profile name must not be clobbered with digits.
  async pauseBot(phone, minutes) {
    await pool.query(
      `INSERT INTO users (id, name, bot_paused_until)
       VALUES ($1, $1, NOW() + make_interval(mins => $2))
       ON CONFLICT (id) DO UPDATE SET bot_paused_until = EXCLUDED.bot_paused_until`,
      [phone, minutes]
    );
  },

  async resumeBot(phone) {
    await pool.query('UPDATE users SET bot_paused_until = NULL WHERE id=$1', [phone]);
  },

  async isBotPaused(phone) {
    const { rows } = await pool.query(
      'SELECT bot_paused_until > NOW() AS paused FROM users WHERE id=$1',
      [phone]
    );
    return rows[0]?.paused === true;
  },

  // ── Services ─────────────────────────────────────────────────────────────
  async getActiveServices() {
    const { rows } = await pool.query(
      'SELECT * FROM services WHERE is_active=true ORDER BY name'
    );
    return rows;
  },

  async getService(id) {
    const { rows } = await pool.query('SELECT * FROM services WHERE id=$1', [id]);
    return rows[0];
  },

  // ── Masters ───────────────────────────────────────────────────────────────
  async getMaster(id) {
    const { rows } = await pool.query('SELECT * FROM masters WHERE id=$1', [id]);
    return rows[0];
  },

  async getMastersForService(serviceId) {
    const { rows } = await pool.query(
      `SELECT m.* FROM masters m
       JOIN master_services ms ON ms.master_id=m.id
       WHERE ms.service_id=$1 AND m.is_active=true
       ORDER BY m.name`,
      [serviceId]
    );
    return rows;
  },

  async setServiceMasters(serviceId, masterIds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM master_services WHERE service_id=$1', [serviceId]);
      for (const masterId of masterIds) {
        await client.query(
          'INSERT INTO master_services (master_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [masterId, serviceId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // ── Appointments ──────────────────────────────────────────────────────────
  async getBookedSlots(masterId, date, excludeApptId = null) {
    const { rows } = await pool.query(
      `SELECT start_time, end_time FROM appointments
       WHERE master_id=$1 AND appointment_date=$2 AND status='confirmed'
         AND ($3::int IS NULL OR id<>$3)`,
      [masterId, date, excludeApptId]
    );
    return rows;
  },

  // Does this master already have anything confirmed that day? A blocks_day
  // service can't be squeezed in next to it.
  async hasAppointmentsOn(masterId, date, excludeApptId = null) {
    const { rows } = await pool.query(
      `SELECT 1 FROM appointments
       WHERE master_id=$1 AND appointment_date=$2 AND status='confirmed'
         AND ($3::int IS NULL OR id<>$3)
       LIMIT 1`,
      [masterId, date, excludeApptId]
    );
    return rows.length > 0;
  },

  // …and the other direction: a blocks_day appointment already sitting there
  // closes the whole day for everyone else.
  async hasDayBlockingAppointmentOn(masterId, date, excludeApptId = null) {
    const { rows } = await pool.query(
      `SELECT 1 FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.master_id=$1 AND a.appointment_date=$2 AND a.status='confirmed'
         AND s.blocks_day = true
         AND ($3::int IS NULL OR a.id<>$3)
       LIMIT 1`,
      [masterId, date, excludeApptId]
    );
    return rows.length > 0;
  },

  async isSlotAvailable(masterId, date, startTime, endTime, excludeApptId = null) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM appointments
       WHERE master_id=$1 AND appointment_date=$2 AND status='confirmed'
         AND NOT (end_time<=$3::time OR start_time>=$4::time)
         AND ($5::int IS NULL OR id<>$5)`,
      [masterId, date, startTime, endTime, excludeApptId]
    );
    return parseInt(rows[0].count) === 0;
  },

  async createAppointment({ userId, masterId, serviceId, date, startTime, endTime }) {
    const { rows } = await pool.query(
      `INSERT INTO appointments
         (user_id, master_id, service_id, appointment_date, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [userId, masterId, serviceId, date, startTime, endTime]
    );
    return rows[0];
  },

  async getUserAppointments(userId) {
    const { rows } = await pool.query(
      `SELECT a.*, m.name AS master_name, s.name AS service_name, s.price
       FROM appointments a
       JOIN masters m ON m.id=a.master_id
       JOIN services s ON s.id=a.service_id
       WHERE a.user_id=$1 AND a.status='confirmed'
         AND a.appointment_date >= CURRENT_DATE
       ORDER BY a.appointment_date, a.start_time`,
      [userId]
    );
    return rows;
  },

  async getAppointmentById(id) {
    const { rows } = await pool.query(
      `SELECT a.*,
              m.name AS master_name,
              s.name AS service_name, s.price,
              u.name AS user_name
       FROM appointments a
       JOIN masters m ON m.id=a.master_id
       JOIN services s ON s.id=a.service_id
       JOIN users u ON u.id=a.user_id
       WHERE a.id=$1`,
      [id]
    );
    return rows[0];
  },

  async cancelAppointment(id) {
    const { rows } = await pool.query(
      `UPDATE appointments SET status='cancelled' WHERE id=$1 RETURNING *`,
      [id]
    );
    return rows[0];
  },

  async rescheduleAppointment(id, { date, startTime, endTime }) {
    const { rows } = await pool.query(
      `UPDATE appointments SET appointment_date=$2, start_time=$3, end_time=$4 WHERE id=$1 RETURNING *`,
      [id, date, startTime, endTime]
    );
    return rows[0];
  },

  // ── Admin: appointments list ────────────────────────────────────────────
  async listAppointments({ dateFrom = null, dateTo = null, masterId = null, status = null } = {}) {
    const { rows } = await pool.query(
      `SELECT a.*, m.name AS master_name, s.name AS service_name, s.price, u.name AS user_name
       FROM appointments a
       JOIN masters m ON m.id=a.master_id
       JOIN services s ON s.id=a.service_id
       JOIN users u ON u.id=a.user_id
       WHERE ($1::date IS NULL OR a.appointment_date >= $1)
         AND ($2::date IS NULL OR a.appointment_date <= $2)
         AND ($3::int IS NULL OR a.master_id = $3)
         AND ($4::text IS NULL OR a.status = $4)
       ORDER BY a.appointment_date, a.start_time`,
      [dateFrom, dateTo, masterId, status]
    );
    return rows;
  },

  // ── Admin: masters CRUD ─────────────────────────────────────────────────
  // Inactive masters are listed too: they still own past appointments and a
  // working-hours template, and the panel needs to be able to switch one
  // back on. Callers that offer a master for *new* work filter on is_active.
  async listMasters() {
    const { rows } = await pool.query(
      'SELECT * FROM masters ORDER BY is_active DESC, name'
    );
    return rows;
  },

  async getActiveMasters() {
    const { rows } = await pool.query('SELECT * FROM masters WHERE is_active=true ORDER BY name');
    return rows;
  },

  async createMaster({ name, description }) {
    const { rows } = await pool.query(
      `INSERT INTO masters (name, description) VALUES ($1,$2) RETURNING *`,
      [name, description || null]
    );
    return rows[0];
  },

  async updateMaster(id, { name, description, isActive }) {
    const { rows } = await pool.query(
      `UPDATE masters SET name=$2, description=$3, is_active=$4
       WHERE id=$1 RETURNING *`,
      [id, name, description || null, isActive]
    );
    return rows[0];
  },

  // Deleting is only offered while nothing points at the row. Appointments
  // and waitlist entries keep a hard reference: dropping a master who has
  // ever been booked would take the history of those bookings with it, so
  // such a master can only be switched off. Working hours, the weekly
  // template, per-date overrides and the service assignment all cascade.
  async deleteMaster(id) {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM appointments WHERE master_id=$1) AS appointments,
              (SELECT count(*) FROM waitlist     WHERE master_id=$1) AS waitlist`,
      [id]
    );
    const appointments = Number(rows[0].appointments);
    const waiting = Number(rows[0].waitlist);
    if (appointments || waiting) return { deleted: false, appointments, waitlist: waiting };

    const { rowCount } = await pool.query('DELETE FROM masters WHERE id=$1', [id]);
    return { deleted: rowCount > 0 };
  },

  // ── Admin: services CRUD ─────────────────────────────────────────────────
  async getAllServices() {
    const { rows } = await pool.query('SELECT * FROM services ORDER BY name');
    return rows;
  },

  async createService({
    name, description, durationMinutes, slotStepMinutes, price,
    earliestStart = null, latestStart = null, blocksDay = false,
  }) {
    const { rows } = await pool.query(
      `INSERT INTO services
         (name, description, duration_minutes, slot_step_minutes, price,
          earliest_start, latest_start, blocks_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, description || null, durationMinutes, slotStepMinutes || 30, price,
       earliestStart || null, latestStart || null, !!blocksDay]
    );
    return rows[0];
  },

  async updateService(id, {
    name, description, durationMinutes, slotStepMinutes, price, isActive,
    earliestStart = null, latestStart = null, blocksDay = false,
  }) {
    const { rows } = await pool.query(
      `UPDATE services
         SET name=$2, description=$3, duration_minutes=$4, slot_step_minutes=$5,
             price=$6, is_active=$7, earliest_start=$8, latest_start=$9, blocks_day=$10
       WHERE id=$1 RETURNING *`,
      [id, name, description || null, durationMinutes, slotStepMinutes || 30, price, isActive,
       earliestStart || null, latestStart || null, !!blocksDay]
    );
    return rows[0];
  },

  // Same rule as deleteMaster: a service that appears in an appointment or
  // on the waitlist can only be hidden, never removed. The master
  // assignment cascades.
  async deleteService(id) {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM appointments WHERE service_id=$1) AS appointments,
              (SELECT count(*) FROM waitlist     WHERE service_id=$1) AS waitlist`,
      [id]
    );
    const appointments = Number(rows[0].appointments);
    const waiting = Number(rows[0].waitlist);
    if (appointments || waiting) return { deleted: false, appointments, waitlist: waiting };

    const { rowCount } = await pool.query('DELETE FROM services WHERE id=$1', [id]);
    return { deleted: rowCount > 0 };
  },

  // ── Schedule: weekly template ────────────────────────────────────────────
  async getScheduleTemplate(masterId) {
    const { rows } = await pool.query(
      'SELECT * FROM schedule_template WHERE master_id=$1 ORDER BY weekday',
      [masterId]
    );
    return rows;
  },

  async getTemplateDay(masterId, weekday) {
    const { rows } = await pool.query(
      'SELECT * FROM schedule_template WHERE master_id=$1 AND weekday=$2',
      [masterId, weekday]
    );
    return rows[0] || null;
  },

  async upsertTemplateDay(masterId, weekday, isWorking, intervals) {
    const { rows } = await pool.query(
      `INSERT INTO schedule_template (master_id, weekday, is_working, intervals)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (master_id, weekday)
       DO UPDATE SET is_working=$3, intervals=$4::jsonb
       RETURNING *`,
      [masterId, weekday, isWorking, JSON.stringify(intervals)]
    );
    return rows[0];
  },

  // ── Schedule: per-date overrides ─────────────────────────────────────────
  async getOverride(masterId, date) {
    const { rows } = await pool.query(
      'SELECT * FROM schedule_override WHERE master_id=$1 AND date=$2',
      [masterId, date]
    );
    return rows[0] || null;
  },

  async listOverrides(masterId, from, to) {
    const { rows } = await pool.query(
      `SELECT * FROM schedule_override
       WHERE master_id=$1 AND date >= $2 AND date <= $3
       ORDER BY date`,
      [masterId, from, to]
    );
    return rows;
  },

  async upsertOverride(masterId, date, kind, intervals) {
    const { rows } = await pool.query(
      `INSERT INTO schedule_override (master_id, date, kind, intervals)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (master_id, date)
       DO UPDATE SET kind=$3, intervals=$4::jsonb
       RETURNING *`,
      [masterId, date, kind, JSON.stringify(intervals)]
    );
    return rows[0];
  },

  // Dropping the row is the whole of "back to the template" — see the schema
  // comment. Never replace it with a copy of the template's hours.
  async deleteOverride(masterId, date) {
    const { rowCount } = await pool.query(
      'DELETE FROM schedule_override WHERE master_id=$1 AND date=$2',
      [masterId, date]
    );
    return rowCount > 0;
  },

  // ── Messages log (for FAQ analysis) ─────────────────────────────────────
  async logMessage({ phone, direction, text }) {
    await pool.query(
      `INSERT INTO messages (phone, direction, text) VALUES ($1,$2,$3)`,
      [phone, direction, text || null]
    );
  },

  async getInboundMessageTexts() {
    const { rows } = await pool.query(
      `SELECT text FROM messages WHERE direction='in' AND text IS NOT NULL ORDER BY created_at`
    );
    return rows.map(r => r.text);
  },

  // ── Waitlist ──────────────────────────────────────────────────────────────
  async addToWaitlist({ userId, masterId, serviceId, date }) {
    const { rows } = await pool.query(
      `INSERT INTO waitlist (user_id, master_id, service_id, desired_date)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [userId, masterId, serviceId, date]
    );
    return rows[0];
  },

  // Is this person already in the queue for that master and date? Both entry
  // points ask before inserting: joining twice would mean two offers for the
  // same freed slot and a second place in a FIFO that is meant to be fair.
  async findActiveWaitlistFor(userId, masterId, date) {
    const { rows } = await pool.query(
      `SELECT * FROM waitlist
       WHERE user_id=$1 AND master_id=$2 AND desired_date=$3
         AND status IN ('waiting','offered')
       ORDER BY created_at LIMIT 1`,
      [userId, masterId, date]
    );
    return rows[0];
  },

  // Oldest still-waiting entry for this master/date (FIFO).
  async getNextWaiting(masterId, date) {
    const { rows } = await pool.query(
      `SELECT w.*, s.duration_minutes, s.slot_step_minutes,
              s.earliest_start, s.latest_start, s.blocks_day
       FROM waitlist w
       JOIN services s ON s.id = w.service_id
       WHERE w.master_id=$1 AND w.desired_date=$2 AND w.status='waiting'
       ORDER BY w.created_at
       LIMIT 1`,
      [masterId, date]
    );
    return rows[0];
  },

  async getWaitlistEntry(id) {
    const { rows } = await pool.query(
      `SELECT w.*, s.name AS service_name, s.duration_minutes, m.name AS master_name
       FROM waitlist w
       JOIN services s ON s.id = w.service_id
       JOIN masters m ON m.id = w.master_id
       WHERE w.id=$1`,
      [id]
    );
    return rows[0];
  },

  async markWaitlistOffered(id, { startTime, endTime }) {
    const { rows } = await pool.query(
      `UPDATE waitlist SET status='offered', offered_start_time=$2, offered_end_time=$3, offered_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id, startTime, endTime]
    );
    return rows[0];
  },

  async markWaitlistStatus(id, status) {
    const { rows } = await pool.query(
      `UPDATE waitlist SET status=$2 WHERE id=$1 RETURNING *`,
      [id, status]
    );
    return rows[0];
  },

  // Offers older than `timeoutMin` minutes ago — expired, move on to next in line.
  async getExpiredWaitlistOffers(timeoutMin) {
    const { rows } = await pool.query(
      `SELECT * FROM waitlist
       WHERE status='offered' AND offered_at < NOW() - ($1 || ' minutes')::interval`,
      [timeoutMin]
    );
    return rows;
  },

  // ── Reminders ─────────────────────────────────────────────────────────────
  // Confirmed, future appointments starting within the next `withinMinutes`
  // (and at least a few minutes out, so we don't refire on ones already past)
  // that haven't had this reminder sent yet.
  async getAppointmentsNeedingReminder(column, withinMinutes) {
    const { rows } = await pool.query(
      `SELECT a.*, m.name AS master_name, s.name AS service_name, u.name AS user_name
       FROM appointments a
       JOIN masters m ON m.id=a.master_id
       JOIN services s ON s.id=a.service_id
       JOIN users u ON u.id=a.user_id
       WHERE a.status='confirmed' AND a.${column}=false
         AND (a.appointment_date + a.start_time) BETWEEN NOW() AND NOW() + ($1 || ' minutes')::interval`,
      [withinMinutes]
    );
    return rows;
  },

  async markReminderSent(apptId, column) {
    await pool.query(`UPDATE appointments SET ${column}=true WHERE id=$1`, [apptId]);
  },

  // ── Baileys auth state (see src/waAuth.js) ──────────────────────────────
  async waAuthGetMany(ids) {
    if (!ids.length) return {};
    const { rows } = await pool.query('SELECT id, data FROM wa_auth WHERE id = ANY($1)', [ids]);
    return Object.fromEntries(rows.map(r => [r.id, r.data]));
  },

  async waAuthSet(id, data) {
    await pool.query(
      `INSERT INTO wa_auth (id, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (id) DO UPDATE SET data=$2::jsonb, updated_at=NOW()`,
      [id, JSON.stringify(data)]
    );
  },

  async waAuthDelete(id) {
    await pool.query('DELETE FROM wa_auth WHERE id=$1', [id]);
  },

  // ── Auto-replies: Instagram (src/instagram.js) and WhatsApp (webhook.js) ─
  // Both lists have the same shape and the same first-match-wins rule, so
  // one pair of helpers serves both tables. The table name is picked from
  // the two literals below and never from a request.
  async getIgReplies() { return listReplies('ig_replies'); },
  async saveIgReplies(replies) { return replaceReplies('ig_replies', replies); },
  async getWaReplies() { return listReplies('wa_replies'); },
  async saveWaReplies(replies) { return replaceReplies('wa_replies', replies); },

  // ── What the Instagram AI answers from ──────────────────────────────────
  // Same "the whole list is rewritten at once" rule as the auto-replies: the
  // order is what the model reads, so a row-by-row save would need a reorder
  // call anyway.
  async getIgKnowledge() {
    const { rows } = await pool.query(
      'SELECT * FROM ig_knowledge WHERE is_active=true ORDER BY position, id'
    );
    return rows;
  },

  async saveIgKnowledge(items) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM ig_knowledge');
      for (const [i, item] of items.entries()) {
        await client.query(
          'INSERT INTO ig_knowledge (title, body, position) VALUES ($1,$2,$3)',
          [item.title, item.body, i]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // True the first time an event id is seen, false on Meta's retries.
  async claimIgEvent(id) {
    const { rowCount } = await pool.query(
      'INSERT INTO ig_events (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [id]
    );
    return rowCount === 1;
  },

  async pruneIgEvents() {
    await pool.query("DELETE FROM ig_events WHERE created_at < NOW() - interval '30 days'");
  },

  // ── Salon settings ────────────────────────────────────────────────────────
  async getSettings() {
    const { rows } = await pool.query('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },

  // An empty string deletes the row: "no address set" and "address set to
  // nothing" are the same thing to everyone reading it.
  async setSettings(values) {
    for (const [key, raw] of Object.entries(values)) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) {
        await pool.query('DELETE FROM settings WHERE key=$1', [key]);
        continue;
      }
      await pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [key, value]
      );
    }
    return this.getSettings();
  },

  async getIgConfig(key) {
    const { rows } = await pool.query('SELECT value FROM ig_config WHERE key=$1', [key]);
    return rows[0]?.value || null;
  },

  async setIgConfig(key, value) {
    await pool.query(
      `INSERT INTO ig_config (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [key, value]
    );
  },
};
