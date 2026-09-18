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

-- Delivered webhook events, so Meta's retries don't answer the same comment
-- twice. Ids are prefixed by kind ("c:<comment id>", "m:<message id>").
CREATE TABLE IF NOT EXISTS ig_events (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Long-lived Instagram tokens expire after 60 days and are refreshed in
-- place, so they cannot live in the environment.
CREATE TABLE IF NOT EXISTS ig_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
`;

export const db = {
  async init() {
    await pool.query(SCHEMA);
    console.log('Database ready');
  },

  async upsertUser({ id, name }) {
    await pool.query(
      `INSERT INTO users (id, name)
       VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET name=$2`,
      [id, name]
    );
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

  // ── Working hours ─────────────────────────────────────────────────────────
  async getWorkingHours(masterId, dayOfWeek) {
    const { rows } = await pool.query(
      'SELECT * FROM working_hours WHERE master_id=$1 AND day_of_week=$2',
      [masterId, dayOfWeek]
    );
    return rows[0];
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

  // ── Admin: services CRUD ─────────────────────────────────────────────────
  async getAllServices() {
    const { rows } = await pool.query('SELECT * FROM services ORDER BY name');
    return rows;
  },

  async createService({ name, description, durationMinutes, price }) {
    const { rows } = await pool.query(
      `INSERT INTO services (name, description, duration_minutes, price)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, description || null, durationMinutes, price]
    );
    return rows[0];
  },

  async updateService(id, { name, description, durationMinutes, price, isActive }) {
    const { rows } = await pool.query(
      `UPDATE services SET name=$2, description=$3, duration_minutes=$4, price=$5, is_active=$6
       WHERE id=$1 RETURNING *`,
      [id, name, description || null, durationMinutes, price, isActive]
    );
    return rows[0];
  },

  // ── Admin: working hours ─────────────────────────────────────────────────
  async getWorkingHoursForMaster(masterId) {
    const { rows } = await pool.query(
      'SELECT * FROM working_hours WHERE master_id=$1 ORDER BY day_of_week',
      [masterId]
    );
    return rows;
  },

  async upsertWorkingHour(masterId, dayOfWeek, startTime, endTime) {
    const { rows } = await pool.query(
      `INSERT INTO working_hours (master_id, day_of_week, start_time, end_time)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (master_id, day_of_week) DO UPDATE SET start_time=$3, end_time=$4
       RETURNING *`,
      [masterId, dayOfWeek, startTime, endTime]
    );
    return rows[0];
  },

  async deleteWorkingHour(masterId, dayOfWeek) {
    await pool.query('DELETE FROM working_hours WHERE master_id=$1 AND day_of_week=$2', [masterId, dayOfWeek]);
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

  // Oldest still-waiting entry for this master/date (FIFO).
  async getNextWaiting(masterId, date) {
    const { rows } = await pool.query(
      `SELECT w.*, s.duration_minutes
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

  // ── Instagram auto-replies (see src/instagram.js) ───────────────────────
  async getIgReplies() {
    const { rows } = await pool.query(
      'SELECT * FROM ig_replies WHERE is_active=true ORDER BY position, id'
    );
    return rows;
  },

  async saveIgReplies(replies) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM ig_replies');
      for (const [i, r] of replies.entries()) {
        await client.query(
          'INSERT INTO ig_replies (keyword, reply, position) VALUES ($1,$2,$3)',
          [r.keyword, r.reply, i]
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
