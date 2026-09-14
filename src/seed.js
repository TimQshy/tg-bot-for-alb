// One-off setup script: creates a sample master, services and working hours
// so the booking flow has something to show. Run: npm run seed
// Edit the data below to match your actual salon before running in production.
// (Talks to the DB directly — there's intentionally no admin panel in this MVP.)
import 'dotenv/config';
import pg from 'pg';

const client = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { db } = await import('./database.js');
await db.init();

const master = (
  await client.query(
    `INSERT INTO masters (name, description) VALUES ($1,$2) RETURNING *`,
    ['Анна', 'Мастер маникюра и педикюра']
  )
).rows[0];

const services = [];
for (const s of [
  { name: 'Маникюр классический', duration: 60, price: 1500 },
  { name: 'Маникюр + гель-лак', duration: 90, price: 2200 },
  { name: 'Педикюр', duration: 75, price: 2000 },
]) {
  const { rows } = await client.query(
    `INSERT INTO services (name, duration_minutes, price) VALUES ($1,$2,$3) RETURNING *`,
    [s.name, s.duration, s.price]
  );
  services.push(rows[0]);
}

for (const s of services) {
  await client.query(
    `INSERT INTO master_services (master_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [master.id, s.id]
  );
}

// Mon–Fri (0=Mon..4=Fri) 09:00–19:00
for (let day = 0; day <= 4; day++) {
  await client.query(
    `INSERT INTO working_hours (master_id, day_of_week, start_time, end_time)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (master_id, day_of_week) DO UPDATE SET start_time=$3, end_time=$4`,
    [master.id, day, '09:00', '19:00']
  );
}

console.log(`Seeded master "${master.name}" with ${services.length} services and Mon–Fri 09:00–19:00 hours.`);
await client.end();
process.exit(0);
