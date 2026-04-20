import { NextResponse } from "next/server";
// @ts-ignore — ical.js doesn't ship official TS types
import ICAL from "ical.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CalendarSource {
  name: string;
  url: string;
}

interface ParsedEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  start: string;       // ISO 8601
  end: string;         // ISO 8601
  allDay: boolean;
  rrule?: string;      // raw RRULE string
  exdates?: string[];  // exception dates
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Remove all emoji and variation selectors from a string */
function stripEmojis(str: string): string {
  if (!str) return str;
  return str
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[\u200D\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Format a Date to iCal DTSTART/DTEND value format */
function toIcalDate(isoStr: string, allDay: boolean): string {
  if (allDay) {
    return isoStr.replace(/-/g, "").substring(0, 8);
  }
  // Convert to UTC format: YYYYMMDDTHHMMSSZ
  const d = new Date(isoStr);
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0") +
    "T" +
    String(d.getUTCHours()).padStart(2, "0") +
    String(d.getUTCMinutes()).padStart(2, "0") +
    String(d.getUTCSeconds()).padStart(2, "0") +
    "Z"
  );
}

/** Escape special characters in iCal text fields */
function escapeIcal(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

/** Fold long iCal lines at 75 chars */
function foldLine(line: string): string {
  const MAX = 75;
  if (line.length <= MAX) return line;
  let result = "";
  let remaining = line;
  result += remaining.substring(0, MAX);
  remaining = remaining.substring(MAX);
  while (remaining.length > 0) {
    result += "\r\n " + remaining.substring(0, MAX - 1);
    remaining = remaining.substring(MAX - 1);
  }
  return result;
}

/** Build a VEVENT block from a ParsedEvent */
function buildVEvent(event: ParsedEvent): string {
  const lines: string[] = ["BEGIN:VEVENT"];

  lines.push(`UID:${event.uid}`);
  lines.push(`DTSTAMP:${toIcalDate(new Date().toISOString(), false)}`);

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toIcalDate(event.start, true)}`);
    lines.push(`DTEND;VALUE=DATE:${toIcalDate(event.end, true)}`);
  } else {
    lines.push(`DTSTART:${toIcalDate(event.start, false)}`);
    lines.push(`DTEND:${toIcalDate(event.end, false)}`);
  }

  lines.push(foldLine(`SUMMARY:${escapeIcal(event.summary)}`));

  if (event.description) {
    lines.push(foldLine(`DESCRIPTION:${escapeIcal(event.description)}`));
  }
  if (event.location) {
    lines.push(foldLine(`LOCATION:${escapeIcal(event.location)}`));
  }
  if (event.url) {
    lines.push(foldLine(`URL:${event.url}`));
  }
  if (event.rrule) {
    lines.push(`RRULE:${event.rrule}`);
  }
  if (event.exdates) {
    for (const exdate of event.exdates) {
      lines.push(`EXDATE:${exdate}`);
    }
  }

  lines.push("END:VEVENT");
  return lines.join("\r\n");
}

/** Parse an ICS string and extract events */
function parseICS(icsText: string, calendarName: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  try {
    const parsed = ICAL.parse(icsText);
    const comp = new ICAL.Component(parsed);
    const vevents: ICAL.Component[] = comp.getAllSubcomponents("vevent");

    for (const vevent of vevents) {
      try {
        const event = new ICAL.Event(vevent);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dtstart = vevent.getFirstPropertyValue("dtstart") as any;
        const allDay =
          dtstart?.isDate === true ||
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (event.startDate as any)?.isDate === true;

        const startDate = event.startDate?.toJSDate?.();
        if (!startDate) continue;
        const endDate = event.endDate?.toJSDate?.() || startDate;

        // Get raw RRULE if present
        const rruleProp = vevent.getFirstProperty("rrule");
        let rruleStr: string | undefined;
        if (rruleProp) {
          rruleStr = rruleProp
            .toICALString()
            .replace(/^RRULE:/, "")
            .trim();
        }

        // Build the new summary: "CAL NAME: original title (no emojis)"
        const cleanCalName = stripEmojis(calendarName).toUpperCase().trim();
        const cleanSummary = stripEmojis(event.summary || "Sin título");
        const newSummary = `${cleanCalName}: ${cleanSummary}`;

        events.push({
          uid: event.uid || `calsync-${Math.random().toString(36).slice(2)}`,
          summary: newSummary,
          description: stripEmojis(event.description || ""),
          location: stripEmojis(event.location || ""),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          url: (event as any).url || "",
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          allDay,
          rrule: rruleStr,
        });
      } catch (evErr) {
        console.warn("[CalSync] Skipped event:", evErr);
      }
    }
  } catch (parseErr) {
    console.error("[CalSync] Failed to parse ICS from", calendarName, parseErr);
  }

  return events;
}

// ─── Route Handler ─────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const sourcesEnv = process.env.CALENDAR_SOURCES;

  if (!sourcesEnv || sourcesEnv.trim() === "") {
    return NextResponse.json(
      {
        error: "No calendar sources configured.",
        hint: "Set the CALENDAR_SOURCES environment variable in Vercel Dashboard → Settings → Environment Variables.",
        example:
          '[{"name":"Personal","url":"https://p01-caldav.icloud.com/published/2/YOURTOKEN/calendar"},{"name":"Trabajo","url":"https://..."}]',
      },
      { status: 500 }
    );
  }

  let sources: CalendarSource[];
  try {
    sources = JSON.parse(sourcesEnv);
  } catch {
    return NextResponse.json(
      { error: "CALENDAR_SOURCES is not valid JSON." },
      { status: 500 }
    );
  }

  if (!Array.isArray(sources) || sources.length === 0) {
    return NextResponse.json(
      { error: "CALENDAR_SOURCES must be a non-empty JSON array." },
      { status: 500 }
    );
  }

  // Fetch all calendars in parallel
  const fetchResults = await Promise.allSettled(
    sources.map(async (source) => {
      const res = await fetch(source.url, {
        headers: { "User-Agent": "CalSync/1.0" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${source.url}`);
      const text = await res.text();
      return { source, text };
    })
  );

  // Parse and collect all events
  const allEvents: ParsedEvent[] = [];
  for (const result of fetchResults) {
    if (result.status === "rejected") {
      console.error("[CalSync] Failed to fetch source:", result.reason);
      continue;
    }
    const { source, text } = result.value;
    const events = parseICS(text, source.name);
    allEvents.push(...events);
  }

  // Build merged ICS output
  const now = toIcalDate(new Date().toISOString(), false);
  const icsLines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CalSync//Calendar Aggregator//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Mis Calendarios",
    `X-WR-CALDESC:Calendario unificado generado por CalSync`,
    "X-WR-TIMEZONE:America/Argentina/Buenos_Aires",
    `X-PUBLISHED-TTL:PT5M`,
  ];

  // Add timezone component for Argentina
  icsLines.push(
    "BEGIN:VTIMEZONE",
    "TZID:America/Argentina/Buenos_Aires",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:-0300",
    "TZOFFSETTO:-0300",
    "TZNAME:ART",
    "END:STANDARD",
    "END:VTIMEZONE"
  );

  for (const event of allEvents) {
    icsLines.push(buildVEvent(event));
  }

  icsLines.push("END:VCALENDAR");
  const icsContent = icsLines.join("\r\n") + "\r\n";

  console.log(
    `[CalSync] Served ${allEvents.length} events from ${sources.length} sources at ${now}`
  );

  return new NextResponse(icsContent, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="mis-calendarios.ics"',
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
