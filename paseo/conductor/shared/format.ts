/**
 * Display helpers for the progress UI. Times show in the viewer's local time zone.
 * Ported from the Progress plugin by Steve Castaneda (MIT).
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "45m", "2h", "2h 15m"; under a minute reads "<1m". */
export function formatMinutes(totalMin: number): string {
  const whole = Math.max(0, Math.floor(totalMin));
  if (whole < 1) return "<1m";
  const hours = Math.floor(whole / 60);
  const minutes = whole % 60;
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** "5m of 10m"; once everything is done, how long it really took. */
export function formatWorkDone(
  doneMin: number,
  totalMin: number,
  tookMin?: number,
): string {
  if (tookMin !== undefined) return formatMinutes(tookMin);
  return `${doneMin < 1 ? "0m" : formatMinutes(doneMin)} of ${formatMinutes(totalMin)}`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

/** Just "2:08 AM" on the same day as `now`; the full clock time otherwise. */
export function formatTimeOfDay(iso: string, now: number): string {
  const full = formatClock(iso);
  return new Date(iso).toDateString() === new Date(now).toDateString()
    ? full.slice(full.indexOf(", ") + 2)
    : full;
}

export function formatAgo(iso: string, now: number): string {
  const minutes = (now - Date.parse(iso)) / 60_000;
  return minutes < 1 ? "just now" : `${formatMinutes(minutes)} ago`;
}

export function minutesSince(iso: string, now: number): number {
  return Math.max(0, (now - Date.parse(iso)) / 60_000);
}

/** Keeps "2h 15m ago" on one line inside wrapping text. */
export function unbroken(text: string): string {
  return text.replaceAll(" ", "\u00a0");
}

/**
 * The time line under a ticket's percent bar: "1h 26m worked · ETA ~2h 34m left", "over by 20m"
 * past the estimate, or "Took 1h 26m of 4h" once settled.
 */
export function formatTicketTime(
  workedMin: number,
  estimateMin: number | undefined,
  settled: boolean,
): { text: string; over: boolean } {
  const worked = formatMinutes(workedMin);
  if (settled)
    return {
      text: estimateMin
        ? `Took ${worked} of ${formatMinutes(estimateMin)}`
        : `Took ${worked}`,
      over: false,
    };
  if (!estimateMin) return { text: `${worked} worked`, over: false };
  const left = estimateMin - workedMin;
  return left >= 1
    ? {
        text: `${worked} worked · ETA ~${formatMinutes(left)} left`,
        over: false,
      }
    : {
        text: `${worked} worked · over the ${formatMinutes(estimateMin)} estimate by ${formatMinutes(-left)}`,
        over: true,
      };
}

/** The same, for a ticket row: "50m of 5h 30m · ETA ~4h 40m", or "over by 20m" past it. */
export function formatTicketTimeShort(
  workedMin: number,
  estimateMin: number | undefined,
  settled: boolean,
): { text: string; over: boolean } {
  const worked = formatMinutes(workedMin);
  if (!estimateMin)
    return {
      text: settled ? `Took ${worked}` : `${worked} worked`,
      over: false,
    };
  const of = `${worked} of ${formatMinutes(estimateMin)}`;
  if (settled) return { text: `Took ${of}`, over: false };
  const left = estimateMin - workedMin;
  return left >= 1
    ? { text: `${of} · ETA ~${formatMinutes(left)}`, over: false }
    : { text: `${of} · over by ${formatMinutes(-left)}`, over: true };
}
