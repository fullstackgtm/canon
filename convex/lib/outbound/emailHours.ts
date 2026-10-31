const DAY = 86_400_000;
type HoursInput = {
  now: number;
  purpose: "automated" | "personal" | "manual";
  recipientTimezone?: string | null;
  companyTimezone?: string | null;
  workspaceTimezone?: string | null;
};
export type EmailHoursResult = { state: "allow" }
  | { state: "held"; notBefore: number; code: "outbound.recipient_hours"; text: string }
  | { state: "refused"; code: "outbound.time_unavailable" | "outbound.timezone_unavailable" | "outbound.purpose_unavailable"; text: string };
type Clock = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const wallTime = (clock: Clock) => Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
const dateTime = (clock: Clock) => Date.UTC(clock.year, clock.month - 1, clock.day);
const weekday = (day: number) => { const value = new Date(day).getUTCDay(); return value >= 1 && value <= 5; };
const open = (clock: Clock) => weekday(dateTime(clock)) && clock.hour >= 8 && clock.hour < 18;

export function automatedEmailHours(input: HoursInput): EmailHoursResult {
  const { now, purpose } = input;
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 10 * DAY) {
    return { state: "refused", code: "outbound.time_unavailable", text: "A valid current time is required." };
  }
  if (purpose === "personal" || purpose === "manual") return { state: "allow" };
  if (purpose !== "automated") return { state: "refused", code: "outbound.purpose_unavailable", text: "A trusted email purpose is required." };
  const zone = input.recipientTimezone ?? input.companyTimezone ?? input.workspaceTimezone;
  try {
    if (typeof zone !== "string" || !zone || zone.trim() !== zone || /^[+-]/.test(zone)) throw new Error("Invalid zone");
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, calendar: "iso8601", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const clockAt = (time: number): Clock => {
      const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
      return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
    };
    const offsetAt = (time: number) => wallTime(clockAt(time)) - Math.floor(time / 1000) * 1000;
    const current = clockAt(now);
    if (open(current)) return { state: "allow" };
    const today = dateTime(current);
    for (let day = 0; day < 8; day++) {
      const date = today + day * DAY;
      if (!weekday(date)) continue;
      const target = date + 8 * 3_600_000;
      const offsets = new Set<number>();
      const transitions: number[] = [];

      let previous = target - 36 * 3_600_000;
      let previousOffset = offsetAt(previous);
      offsets.add(previousOffset);
      for (let sample = previous + 6 * 3_600_000; sample <= target + 36 * 3_600_000; sample += 6 * 3_600_000) {
        const offset = offsetAt(sample);
        offsets.add(offset);
        if (offset !== previousOffset) {
          let low = previous, high = sample;
          while (high - low > 1) {
            const middle = low + Math.floor((high - low) / 2);
            if (offsetAt(middle) === previousOffset) low = middle;
            else high = middle;
          }
          transitions.push(high);
        }
        previous = sample; previousOffset = offset;
      }
      const candidates = [...offsets].map((offset) => target - offset).concat(transitions)
        .filter((time) => time > now && dateTime(clockAt(time)) === date && open(clockAt(time)));
      if (candidates.length) return { state: "held", notBefore: Math.min(...candidates), code: "outbound.recipient_hours", text: "Automated email waits for Monday through Friday, 08:00 to 18:00 in the recipient's resolved timezone." };
    }
  } catch {  }
  return { state: "refused", code: "outbound.timezone_unavailable", text: "A valid canonical recipient, company or workspace timezone is required." };
}
