/** Date-only arithmetic deliberately uses UTC; the timezone only selects the civil date. */
export function civilDate(
  now = new Date(),
  timeZone = process.env.APP_TIME_ZONE || 'America/Denver',
) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type) => parts.find((p) => p.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const zones = new WeakMap();
export const timeZoneFor = (db) =>
  zones.get(db) || process.env.APP_TIME_ZONE || 'America/Denver';
export const dateFor = (db) => civilDate(new Date(), timeZoneFor(db));
export function configureDates(db, timeZone = timeZoneFor(db)) {
  civilDate(new Date(), timeZone); // Validate before changing the live clock.
  zones.set(db, timeZone);
  db.function('app_today', () => dateFor(db));
}
