// One-off setup script: creates a sample master, services and a weekly
// schedule so the booking flow has something to show. Run: npm run seed
// Edit the data below to match your actual salon before running in production.
import 'dotenv/config';
import { db } from './database.js';

await db.init();

const master = await db.createMaster({
  name: 'Анна',
  description: 'Мастер маникюра и педикюра',
});

const services = [];
for (const s of [
  { name: 'Маникюр классический', duration: 60, step: 30, price: 1500 },
  { name: 'Маникюр + гель-лак', duration: 90, step: 30, price: 2200 },
  { name: 'Педикюр', duration: 75, step: 30, price: 2000 },
]) {
  services.push(await db.createService({
    name: s.name, description: null,
    durationMinutes: s.duration, slotStepMinutes: s.step, price: s.price,
  }));
}

for (const s of services) {
  await db.setServiceMasters(s.id, [master.id]);
}

// Mon–Fri (0=Mon..4=Fri) 09:00–19:00, no breaks. Per-date exceptions are the
// salon's to add from the panel.
for (let weekday = 0; weekday <= 4; weekday++) {
  await db.upsertTemplateDay(master.id, weekday, true, [
    { from: '09:00', to: '19:00', breaks: [] },
  ]);
}

console.log(`Seeded master "${master.name}" with ${services.length} services and Mon–Fri 09:00–19:00 hours.`);
process.exit(0);
