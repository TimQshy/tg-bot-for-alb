import pg from 'pg';
const { Pool, types } = pg;

// Return BIGINT as JS number (safe for Telegram IDs)
types.setTypeParser(20, val => parseInt(val, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const TZ = process.env.TIMEZONE || 'Europe/Moscow';

pool.on('connect', client => {
  client.query(`SET timezone = '${TZ}'`);
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
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
  user_id BIGINT REFERENCES users(id),
  master_id INTEGER REFERENCES masters(id),
  service_id INTEGER REFERENCES services(id),
  appointment_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  reminder_24h_sent BOOLEAN DEFAULT false,
  reminder_1h_sent BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appt_date   ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appt_user   ON appointments(user_id);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
`;

export const db = {
  async init() {
    await pool.query(SCHEMA);
    console.log('Database ready');
  },

  async upsertUser({ id, username, first_name, last_name }) {
    await pool.query(
      `INSERT INTO users (id, username, first_name, last_name)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE
         SET username=$2, first_name=$3, last_name=$4`,
      [id, username || null, first_name, last_name || null]
    );
  },

  // ── Services ─────────────────────────────────────────────────────────────
  async getActiveServices() {
    const { rows } = await pool.query(
      'SELECT * FROM services WHERE is_active=true ORDER BY name'
    );
    return rows;
  },

  async getAllServices() {
    const { rows } = await pool.query('SELECT * FROM services ORDER BY name');
    return rows;
  },

  async getService(id) {
    const { rows } = await pool.query('SELECT * FROM services WHERE id=$1', [id]);
    return rows[0];
  },

  async createService({ name, description, durationMinutes, price }) {
    const { rows } = await pool.query(
      `INSERT INTO services (name, description, duration_minutes, price)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, description || null, durationMinutes, price]
    );
    return rows[0];
  },

  async toggleServiceActive(id) {
    const { rows } = await pool.query(
      'UPDATE services SET is_active=NOT is_active WHERE id=$1 RETURNING *',
      [id]
    );
    return rows[0];
  },

  // ── Masters ───────────────────────────────────────────────────────────────
  async getAllMasters() {
    const { rows } = await pool.query('SELECT * FROM masters ORDER BY name');
    return rows;
  },

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

  async createMaster({ name, description }) {
    const { rows } = await pool.query(
      'INSERT INTO masters (name, description) VALUES ($1,$2) RETURNING *',
      [name, description || null]
    );
    return rows[0];
  },

  async toggleMasterActive(id) {
    const { rows } = await pool.query(
      'UPDATE masters SET is_active=NOT is_active WHERE id=$1 RETURNING *',
      [id]
    );
    return rows[0];
  },

  // ── Master ↔ Service links ─────────────────────────────────────────────
  async getMasterServices(masterId) {
    const { rows } = await pool.query(
      `SELECT s.* FROM services s
       JOIN master_services ms ON ms.service_id=s.id
       WHERE ms.master_id=$1`,
      [masterId]
    );
    return rows;
  },

  async addMasterService(masterId, serviceId) {
    await pool.query(
      `INSERT INTO master_services (master_id, service_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [masterId, serviceId]
    );
  },

  async removeMasterService(masterId, serviceId) {
    await pool.query(
      'DELETE FROM master_services WHERE master_id=$1 AND service_id=$2',
      [masterId, serviceId]
    );
  },

  // ── Working hours ─────────────────────────────────────────────────────────
  async getWorkingHours(masterId, dayOfWeek) {
    const { rows } = await pool.query(
      'SELECT * FROM working_hours WHERE master_id=$1 AND day_of_week=$2',
      [masterId, dayOfWeek]
    );
    return rows[0];
  },

  async getAllWorkingHours(masterId) {
    const { rows } = await pool.query(
      'SELECT * FROM working_hours WHERE master_id=$1 ORDER BY day_of_week',
      [masterId]
    );
    return rows;
  },

  async setWorkingHour(masterId, dayOfWeek, startTime, endTime) {
    await pool.query(
      `INSERT INTO working_hours (master_id, day_of_week, start_time, end_time)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (master_id, day_of_week)
       DO UPDATE SET start_time=$3, end_time=$4`,
      [masterId, dayOfWeek, startTime, endTime]
    );
  },

  async deleteWorkingHour(masterId, dayOfWeek) {
    await pool.query(
      'DELETE FROM working_hours WHERE master_id=$1 AND day_of_week=$2',
      [masterId, dayOfWeek]
    );
  },

  // ── Appointments ──────────────────────────────────────────────────────────
  async getBookedSlots(masterId, date) {
    const { rows } = await pool.query(
      `SELECT start_time, end_time FROM appointments
       WHERE master_id=$1 AND appointment_date=$2 AND status='confirmed'`,
      [masterId, date]
    );
    return rows;
  },

  async isSlotAvailable(masterId, date, startTime, endTime) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM appointments
       WHERE master_id=$1 AND appointment_date=$2 AND status='confirmed'
         AND NOT (end_time<=$3::time OR start_time>=$4::time)`,
      [masterId, date, startTime, endTime]
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
              u.first_name AS user_first_name, u.last_name AS user_last_name,
              u.username AS user_username
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

  async getAppointmentsByDate(date) {
    const { rows } = await pool.query(
      `SELECT a.*,
              m.name AS master_name,
              s.name AS service_name, s.price,
              u.first_name AS user_first_name, u.last_name AS user_last_name,
              u.username AS user_username
       FROM appointments a
       JOIN masters m ON m.id=a.master_id
       JOIN services s ON s.id=a.service_id
       JOIN users u ON u.id=a.user_id
       WHERE a.appointment_date=$1 AND a.status='confirmed'
       ORDER BY a.start_time`,
      [date]
    );
    return rows;
  },

  async getUpcomingAppointments(limit = 20) {
    const { rows } = await pool.query(
      `SELECT a.*,
              m.name AS master_name,
              s.name AS service_name,
              u.first_name AS user_first_name, u.last_name AS user_last_name,
              u.username AS user_username
       FROM appointments a
       JOIN masters m ON m.id=a.master_id
       JOIN services s ON s.id=a.service_id
       JOIN users u ON u.id=a.user_id
       WHERE a.status='confirmed' AND a.appointment_date >= CURRENT_DATE
       ORDER BY a.appointment_date, a.start_time
       LIMIT $1`,
      [limit]
    );
    return rows;
  },

  // ── Reminders ─────────────────────────────────────────────────────────────
  async getPendingReminders24h() {
    const { rows } = await pool.query(
      `SELECT a.*, u.id AS tg_user_id,
              m.name AS master_name, s.name AS service_name
       FROM appointments a
       JOIN users u ON u.id=a.user_id
       JOIN masters m ON m.id=a.master_id
       JOIN services s ON s.id=a.service_id
       WHERE a.status='confirmed'
         AND a.reminder_24h_sent=false
         AND (a.appointment_date + a.start_time) BETWEEN
               NOW() + INTERVAL '23 hours 30 minutes'
           AND NOW() + INTERVAL '24 hours 30 minutes'`
    );
    return rows;
  },

  async getPendingReminders1h() {
    const { rows } = await pool.query(
      `SELECT a.*, u.id AS tg_user_id,
              m.name AS master_name, s.name AS service_name
       FROM appointments a
       JOIN users u ON u.id=a.user_id
       JOIN masters m ON m.id=a.master_id
       JOIN services s ON s.id=a.service_id
       WHERE a.status='confirmed'
         AND a.reminder_1h_sent=false
         AND (a.appointment_date + a.start_time) BETWEEN
               NOW() + INTERVAL '30 minutes'
           AND NOW() + INTERVAL '1 hour 30 minutes'`
    );
    return rows;
  },

  async markReminderSent(id, type) {
    const col = type === '24h' ? 'reminder_24h_sent' : 'reminder_1h_sent';
    await pool.query(`UPDATE appointments SET ${col}=true WHERE id=$1`, [id]);
  },
};
