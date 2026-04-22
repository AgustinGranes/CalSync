import { NextResponse } from "next/server";
// @ts-ignore — ical.js ships its own types
import ICAL from "ical.js";
import { getAdminFirestore } from "@/lib/firebase-admin";
import { UserConfig, EventOverride, CalendarException } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripEmojis(str: string): string {
  if (!str) return str;
  return str
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[\u200D\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function toIcalDate(isoStr: string, allDay: boolean): string {
  if (allDay) {
    return isoStr.replace(/-/g, "").substring(0, 8);
  }
  const d = new Date(isoStr);
  return (
    d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0") +
    "T" +
    String(d.getUTCHours()).padStart(2, "0") +
    String(d.getUTCMinutes()).padStart(2, "0") +
    String(d.getUTCSeconds()).padStart(2, "0") +
    "Z"
  );
}

function escapeIcal(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

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

function formatTrigger(minutes: number): string {
  if (minutes % 1440 === 0) {
    return `-P${minutes / 1440}D`;
  } else if (minutes % 60 === 0) {
    return `-PT${minutes / 60}H`;
  } else {
    return `-PT${minutes}M`;
  }
}

function buildVEvent(event: ParsedEvent, alert1: number, alert2: number): string {
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

  const addAlarm = (minutes: number, label: string) => {
    if (minutes <= 0) return;
    const trigger = formatTrigger(minutes);
    lines.push("BEGIN:VALARM");
    lines.push(`TRIGGER:${trigger}`);
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${label}`);
    lines.push("END:VALARM");
  };

  addAlarm(alert1, "Primer Alerta");
  addAlarm(alert2, "Segunda Alerta");

  lines.push("END:VEVENT");
  return lines.join("\r\n");
}

function parseICS(
  icsText: string,
  calendarName: string,
  showEmojis: boolean,
  showCalendarName: boolean,
  eventOverrides: Record<string, EventOverride>,
  hidePastEvents: boolean,
  hideLocation: boolean
): ParsedEvent[] {
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

        // Get RRULE if present
        const rruleProp = vevent.getFirstProperty("rrule");
        let rruleStr: string | undefined;
        if (rruleProp) {
          rruleStr = rruleProp
            .toICALString()
            .replace(/^RRULE:/, "")
            .trim();
        }

        // Determine UID (consistent fallback for overrides)
        const rawSummary0 = event.summary || "Sin t\u00edtulo";
        const startIso = startDate.toISOString();
        const uid = event.uid || `calsync-${calendarName}-${startIso}-${rawSummary0.slice(0, 20)}`;

        // Apply user override if present
        const ov = eventOverrides[uid] ?? {};
        if (ov.deleted) continue;

        const rawSummary = (ov.summary !== undefined ? ov.summary : rawSummary0);
        const cleanSummary = showEmojis ? rawSummary : stripEmojis(rawSummary);

        // Build formatted summary (prefix added later if dedup is off; kept here if dedup is on)
        let newSummary: string;
        if (showCalendarName) {
          const cleanCalName = (showEmojis ? calendarName : stripEmojis(calendarName)).toUpperCase().trim();
          newSummary = `${cleanCalName}: ${cleanSummary}`;
        } else {
          newSummary = cleanSummary;
        }

        const finalEnd = ov.end !== undefined ? ov.end : (endDate ? endDate.toISOString() : startIso);

        if (hidePastEvents) {
          const endObj = new Date(finalEnd);
          if (!isNaN(endObj.getTime()) && endObj.getTime() < Date.now()) {
            continue;
          }
        }

        const location = hideLocation ? "" : (ov.location !== undefined ? ov.location : (event.location || ""));
        const description = ov.description !== undefined ? ov.description : (event.description || "");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const url = ov.url !== undefined ? ov.url : ((event as any).url || vevent.getFirstPropertyValue("url") || "");

        events.push({
          uid,
          rawSummary: cleanSummary, // emoji-processed base title, no prefix
          calendarName,
          summary: newSummary,
          description: showEmojis ? description : stripEmojis(description),
          location: showEmojis ? location : stripEmojis(location),
          url,
          start: ov.start !== undefined ? ov.start : startIso,
          end: finalEnd,
          allDay,
          rrule: rruleStr,
          calendarId: "", // will be filled or used for exception matching if needed
        });
      } catch (evErr) {
        console.warn("[CalSync] Skipped event:", evErr);
      }
    }
  } catch (parseErr) {
    console.error("[CalSync] Failed to parse ICS for", calendarName, parseErr);
  }
  return events;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedEvent {
  uid: string;
  rawSummary: string;   // base title BEFORE calendar prefix (for dedup key)
  calendarName: string; // source calendar name (for prefix building)
  calendarId: string;   // source calendar ID (for exception matching)
  summary: string;      // final formatted summary (written to ICS)
  description: string;
  location: string;
  url: string;
  start: string;
  end: string;
  allDay: boolean;
  rrule?: string;
}

/**
 * Deduplication: group events by (normalizedBaseTitle, startISO).
 * If multiple calendars share the same event, merge their calendar
 * name prefixes: "ARSENAL y CHELSEA: FA Cup"
 */
function deduplicateByTitle(
  events: ParsedEvent[],
  showCalendarName: boolean,
  showEmojis: boolean,
  exceptions?: CalendarException[]
): ParsedEvent[] {
  // key = normalised title (lowercase, no extra spaces) + start datetime
  const groups = new Map<string, ParsedEvent[]>();

  for (const ev of events) {
    const normalised = ev.rawSummary.toLowerCase().replace(/\s+/g, " ").trim();
    const key = `${normalised}|${ev.start}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }

  const result: ParsedEvent[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      const ev = group[0];
      // Even if not a merge, check if this single event needs its summary adjusted if we added prefix in parseICS but exception says no
      // Actually, it's better to NOT add prefix in parseICS and always add it here or in a separate pass.
      // But let's follow the existing logic but respect exceptions.
      result.push(ev);
      continue;
    }
    // Merge: collect unique calendar names in stable order
    const base = group[0];
    const baseRaw = base.rawSummary;

    // Filter calendars that should show their name
    const calendarsToShowName = group.filter(ev => {
      const exc = exceptions?.find(e => e.calendarId === ev.calendarId);
      return exc?.showCalendarName !== undefined ? exc.showCalendarName : showCalendarName;
    });

    let mergedSummary: string;
    if (calendarsToShowName.length > 0) {
      const calNames = [...new Set(calendarsToShowName.map((e) => e.calendarName))];
      const prefix = calNames
        .map((n) => {
          // We need to know which calendar this name belongs to to check emoji exception
          // For simplicity, if ANY included calendar has emojis enabled, we show them in the merged prefix?
          // No, let's use the first one's setting or global.
          const firstCalWithThisName = calendarsToShowName.find(e => e.calendarName === n);
          const exc = exceptions?.find(e => e.calendarId === firstCalWithThisName?.calendarId);
          const useEmojis = exc?.showEmojis !== undefined ? exc.showEmojis : showEmojis;
          return (useEmojis ? n : stripEmojis(n)).toUpperCase().trim();
        })
        .join(" y ");
      mergedSummary = `${prefix}: ${baseRaw}`;
    } else {
      mergedSummary = baseRaw;
    }

    result.push({ ...base, summary: mergedSummary });
  }
  return result;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ uid: string }> }
) {
  const { uid } = await params;

  if (!uid) {
    return new NextResponse("Missing user ID", { status: 400 });
  }

  // Load user config from Firestore
  let userConfig: UserConfig;
  try {
    const adminDb = getAdminFirestore();
    const userRef = adminDb.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return new NextResponse("User not found", { status: 404 });
    }

    userConfig = userSnap.data() as UserConfig;
  } catch (err) {
    console.error("[CalSync] Firestore error:", err);
    return new NextResponse("Database error", { status: 500 });
  }

  const enabledCalendars = (userConfig.calendars || []).filter((c) => c.enabled);

  if (enabledCalendars.length === 0) {
    // Return a valid but empty calendar
    const empty = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//CalSync//Calendar Aggregator//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Mis Calendarios (vacío)",
      "END:VCALENDAR",
    ].join("\r\n") + "\r\n";

    return new NextResponse(empty, {
      status: 200,
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
    });
  }

  // Fetch all enabled calendars in parallel
  const fetchResults = await Promise.allSettled(
    enabledCalendars.map(async (cal) => {
      const res = await fetch(cal.url, {
        headers: { "User-Agent": "CalSync/2.0" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${cal.url}`);
      const text = await res.text();
      return { cal, text };
    })
  );

  // Parse and merge events
  const showEmojis = userConfig.showEmojis ?? false;
  const showCalName = userConfig.showCalendarName ?? true;
  const deduplicate = userConfig.deduplicateEvents ?? false;
  const hidePastEvents = userConfig.hidePastEvents ?? false;
  const hideLocation = userConfig.hideLocation ?? false;
  const overrides = userConfig.eventOverrides ?? {};
  let allEvents: ParsedEvent[] = [];
  for (const result of fetchResults) {
    if (result.status === "rejected") {
      console.error("[CalSync] Failed to fetch calendar:", result.reason);
      continue;
    }
    const { cal, text } = result.value;
    const exc = (userConfig.calendarExceptions || []).find((e) => e.calendarId === cal.id);
    const useEmojis = exc?.showEmojis !== undefined ? exc.showEmojis : showEmojis;
    const useCalName = exc?.showCalendarName !== undefined ? exc.showCalendarName : showCalName;
    const useHideLocation = exc?.hideLocation !== undefined ? exc.hideLocation : hideLocation;

    const parsed = parseICS(text, cal.name, useEmojis, useCalName, overrides, hidePastEvents, useHideLocation);
    // Add calendarId to each event for deduplication logic
    parsed.forEach(ev => { ev.calendarId = cal.id; });
    allEvents.push(...parsed);
  }

  // Always deduplicate to ensure "no repeats"
  allEvents = deduplicateByTitle(allEvents, showCalName, showEmojis, userConfig.calendarExceptions);

  const now = toIcalDate(new Date().toISOString(), false);

  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CalSync//Calendar Aggregator//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Mis Calendarios",
    "X-WR-CALDESC:Calendario unificado por CalSync",
    "X-WR-TIMEZONE:America/Argentina/Buenos_Aires",
    "X-PUBLISHED-TTL:PT5M",
    // Argentina timezone
    "BEGIN:VTIMEZONE",
    "TZID:America/Argentina/Buenos_Aires",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:-0300",
    "TZOFFSETTO:-0300",
    "TZNAME:ART",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  const alert1 = 15;
  const alert2 = 5;

  for (const event of allEvents) {
    icsLines.push(buildVEvent(event, alert1, alert2));
  }

  icsLines.push("END:VCALENDAR");
  const icsContent = icsLines.join("\r\n") + "\r\n";

  console.log(
    `[CalSync] uid=${uid} served ${allEvents.length} events from ${enabledCalendars.length} calendars at ${now}`
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
