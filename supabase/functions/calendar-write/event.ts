// Pure: builds the Google Calendar event resource for a booking (or one day of it). Tested by event.test.mjs (Node).
const TZ = "America/New_York";
// Pure: the Google event resource. Exported for the Node test (functions/calendar-write/test.mjs).
export function eventBody(o: {
  orgName: string; typeLabel: string; titleLabel: string; titleOverride?: string | null; startAt: string; endAt: string;
  location?: string | null; notes?: string | null; accessCode?: string | null; retakeDay?: string | null;
  wifiNetwork?: string | null; wifiPassword?: string | null; // On-site details on the job page (2026-10-24)
  contacts: { name: string; email?: string | null; role?: string | null }[]; shortId: string;
  allDay?: boolean;            // no start time yet: an all-day event, never a guessed time
  dayLabel?: string | null;    // "Flag football": which teams this day is for (multi-day jobs)
  dayNote?: string | null;     // "Day 2 of 2"
}) {
  const base = (o.titleOverride && o.titleOverride.trim()) || `${o.orgName} • ${o.titleLabel || o.typeLabel}`;
  const title = o.dayLabel && o.dayLabel.trim() ? `${base} • ${o.dayLabel.trim()}` : base;
  const lines: string[] = [];
  if (o.dayNote) lines.push(o.dayNote);
  if (o.allDay) lines.push("Time not set yet. Set it in 207 Admin and this event becomes a timed block.");
  // What the crew needs on site goes first, so a phone shows it without scrolling.
  const net = o.wifiNetwork?.trim(), pw = o.wifiPassword?.trim();
  if (net || pw) lines.push("WiFi: " + [net, pw ? `password ${pw}` : ""].filter(Boolean).join(" \u00b7 "));
  if (o.notes && o.notes.trim()) lines.push(`For the crew: ${o.notes.trim()}`);
  if (net || pw || (o.notes && o.notes.trim())) lines.push("");
  for (const c of o.contacts) lines.push(`Contact: ${[c.name, c.role ? `(${c.role})` : "", c.email ?? ""].filter(Boolean).join(" ")}`.trim());
  lines.push(`Type: ${o.typeLabel}`);
  if (o.accessCode) lines.push(`Access code: ${o.accessCode}`);
  if (o.retakeDay) lines.push(`Retake day: ${o.retakeDay}`);
  lines.push(`Booked in 207 Admin · ${o.shortId}`);
  let start = new Date(o.startAt), end = new Date(o.endAt);
  if (!(end > start)) end = new Date(start.getTime() + 60 * 60000);
  const ev: any = {
    summary: title.slice(0, 250),
    description: lines.join("\n"),
    location: o.location?.trim() || undefined,
    reminders: { useDefault: true },
  };
  // PATCH merges start/end into the existing event, so the other form is cleared with null: an all-day
  // event that gets a time (or the reverse) would otherwise keep both and Google answers "Invalid start time".
  if (o.allDay) {
    const day = start.toLocaleDateString("en-CA", { timeZone: TZ });
    const next = new Date(new Date(day + "T12:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
    ev.start = { date: day, dateTime: null, timeZone: null }; ev.end = { date: next, dateTime: null, timeZone: null };
  } else {
    ev.start = { date: null, dateTime: start.toISOString(), timeZone: TZ };
    ev.end = { date: null, dateTime: end.toISOString(), timeZone: TZ };
  }
  return ev;
}
