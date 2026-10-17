/** A calendar day as `YYYY-MM-DD`; the form DatePicker stores and @DateIn compares. */
export type IsoDate = string;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIso(value: unknown): { year: number; month: number; day: number } | null {
  const match = typeof value === "string" ? ISO.exec(value.trim()) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function formatIso(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Month shifted by `delta`, rolling the year; `month` is 1 to 12. */
export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** The weeks of a month, Sunday first by default; days outside the month are null. */
export function monthGrid(year: number, month: number, weekStart = 0): (IsoDate | null)[][] {
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() - weekStart + 7) % 7;
  const cells: (IsoDate | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth(year, month) }, (_, index) => formatIso(year, month, index + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

/** What a DatePicker holds as a list: [] for nothing, [day] for a start still waiting for its end, [start, end]. */
export function asRange(value: unknown): IsoDate[] {
  const list = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  return list.filter((item): item is IsoDate => parseIso(item) !== null).slice(0, 2).sort();
}

/** The next value after the user picks `day`. A range starts over once it is complete. */
export function pickDay(current: unknown, day: IsoDate, range: boolean): IsoDate | IsoDate[] {
  if (!range) return day;
  const [start, end] = asRange(current);
  if (start === undefined || end !== undefined) return [day];
  return [start, day].sort();
}

/** Whether `day` falls inside the value: the same day, or between both ends of a range. */
export function covers(value: unknown, day: IsoDate): boolean {
  const [start, end] = asRange(value);
  if (start === undefined) return false;
  if (end === undefined) return start === day;
  return day >= start && day <= end;
}

/** Rows whose `field` date is inside `value` (a day or a [start, end] range). No value keeps every row. */
export function rowsOnDates(rows: unknown, field: string, value: unknown): unknown[] {
  if (!Array.isArray(rows)) return [];
  const [start, last] = asRange(value);
  if (start === undefined) return rows;
  const end = last ?? start;
  return rows.filter((row) => {
    const day = field && row && typeof row === "object" ? (row as Record<string, unknown>)[field] : row;
    return typeof day === "string" && day.slice(0, 10) >= start && day.slice(0, 10) <= end;
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function weekdayLabels(weekStart = 0): string[] {
  return Array.from({ length: 7 }, (_, index) => WEEKDAYS[(index + weekStart) % 7] ?? "");
}

/** The month a picker opens on: the first picked day, else the current month held inside min and max. */
export function startMonth(
  value: unknown,
  min: unknown,
  max: unknown,
  now: { year: number; month: number },
): { year: number; month: number } {
  const held = parseIso(asRange(value)[0]);
  if (held) return held;
  const key = (month: { year: number; month: number }) => month.year * 12 + month.month;
  const [low, high] = [parseIso(min), parseIso(max)];
  if (low && key(now) < key(low)) return low;
  if (high && key(now) > key(high)) return high;
  return now;
}
