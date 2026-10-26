/** A calendar day as an ISO string, "2025-03-04". The shop never deals in times of day. */
export type Day = string;

const MS_PER_DAY = 86_400_000;

/** True when the text is a real calendar day in ISO form. */
export function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === text;
}

/** Days since 1970-01-01. Throws on text that is not a day. */
export function dayNumber(day: Day): number {
  if (!isDay(day)) throw new Error(`not an ISO day: ${day}`);
  return Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY;
}

export function fromDayNumber(n: number): Day {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(day: Day, n: number): Day {
  return fromDayNumber(dayNumber(day) + n);
}

/** Whole days from one day to another: 0 for the same day, negative when `to` is earlier. */
export function daysBetween(from: Day, to: Day): number {
  return dayNumber(to) - dayNumber(from);
}

export function compareDays(a: Day, b: Day): number {
  return dayNumber(a) - dayNumber(b);
}

/** 0 for Sunday through 6 for Saturday. */
export function weekday(day: Day): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function isWeekend(day: Day): boolean {
  const w = weekday(day);
  return w === 0 || w === 6;
}

/** Every day from `from` up to but not including `to`. */
export function eachDay(from: Day, to: Day): Day[] {
  const days: Day[] = [];
  for (let n = dayNumber(from); n < dayNumber(to); n++) days.push(fromDayNumber(n));
  return days;
}
