/**
 * Calling hours (docs/dialer.md, compliance). The TCPA and the TSR allow
 * telemarketing calls only between 8 a.m. and 9 p.m. at the called person's
 * location. Canon knows a contact's number, not where they are, so for North
 * American numbers it reads the area code: Hawaii, Alaska and the territories
 * have their own zones; every other +1 number may be anywhere from Eastern to
 * Pacific, so it is callable only while it's 8 a.m. to 9 p.m. in both.
 * Numbers outside +1 aren't under the US rules; Canon doesn't hold them to a
 * window.
 *
 * Pure: Intl only.
 */

export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 21;

/** +1 area codes whose zone isn't somewhere from Eastern to Pacific. */
const OWN_ZONE: Readonly<Record<string, string>> = {
  "808": "Pacific/Honolulu",
  "907": "America/Anchorage",
  "787": "America/Puerto_Rico",
  "939": "America/Puerto_Rico",
  "340": "America/St_Thomas",
  "671": "Pacific/Guam",
  "670": "Pacific/Saipan",
  "684": "Pacific/Pago_Pago",
};

/** The zones a +1 number may be in. */
export function zonesFor(e164: string): string[] | null {
  if (!e164.startsWith("+1") || e164.length !== 12) return null;
  const own = OWN_ZONE[e164.slice(2, 5)];
  return own ? [own] : ["America/New_York", "America/Los_Angeles"];
}

const hourIn = (zone: string, now: number) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(now));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour + minute / 60;
};

const clockIn = (zone: string, now: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(now));

/** Why the number can't be called right now, or null when it can. */
export function callingHoursProblem(e164: string, now: number): string | null {
  const zones = zonesFor(e164);
  if (!zones) return null;
  const closed = zones.find((zone) => {
    const h = hourIn(zone, now);
    return h < OPEN_HOUR || h >= CLOSE_HOUR;
  });
  if (!closed) return null;
  return `It's ${clockIn(closed, now)} where this number may be. Calls are allowed 8 AM to 9 PM in the contact's time zone.`;
}
