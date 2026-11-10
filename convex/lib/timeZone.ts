/**
 * Wall-clock reads of an instant in a named IANA time zone: the workspace's (calendar views, automations) or a
 * sender's (LinkedIn sending windows). Pure: no database access, no Node-only imports.
 */

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The local date, weekday and minute of the day at `nowMs` in `tz`. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (tz: string) => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
};

export function localTime(nowMs: number, tz: string): { date: string; weekday: number; minute: number } {
  const parts = Object.fromEntries(
    formatterFor(tz)
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

