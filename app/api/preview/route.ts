import { NextResponse } from "next/server";
// @ts-ignore
import ICAL from "ical.js";
import { getAdminFirestore } from "@/lib/firebase-admin";
import { UserConfig, CalendarSource, EventOverride } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export interface RawEvent {
  uid: string;           // ICS event UID (used as override key)
  summary: string;       // raw original summary (before any formatting)
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  url: string;
  description: string;
  calendarId: string;
  calendarName: string;
}

/** Deterministic fallback UID for events that don't have one */
function makeUid(calName: string, startIso: string, summary: string): string {
  return `calsync-${calName}-${startIso}-${summary.slice(0, 20)}`;
}

function stripEmojisServer(str: string): string {
  if (!str) return str;
  return str
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[\u200D\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Merge duplicate events across calendars for the preview list.
 * Key = normalised summary (lower, no extra spaces) + start ISO.
 * Merged event: calendarName becomes "CAL1 y CAL2", summary unchanged.
 */
function deduplicatePreviewEvents(
  events: RawEvent[],
  showEmojis: boolean
): RawEvent[] {
  const groups = new Map<string, RawEvent[]>();
  for (const ev of events) {
    const base = showEmojis ? ev.summary : stripEmojisServer(ev.summary);
    const key = `${base.toLowerCase().replace(/\s+/g, " ").trim()}|${ev.start}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ev);
  }
  const result: RawEvent[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { result.push(group[0]); continue; }
    const calNames = [...new Set(group.map((e) => e.calendarName))];
    // Merge calendarName for display ("ARSENAL y CHELSEA")
    result.push({ ...group[0], calendarName: calNames.join(" y ") });
  }
  return result;
}

/** Parse a single ICS text into RawEvents, applying eventOverrides */
function parseCalendarToRaw(
  text: string,
  cal: CalendarSource,
  overrides: Record<string, EventOverride>,
  hidePastEvents: boolean,
  hideLocation: boolean
): RawEvent[] {
  const events: RawEvent[] = [];
  try {
    const parsed = ICAL.parse(text);
    const comp = new ICAL.Component(parsed);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vevents: any[] = comp.getAllSubcomponents("vevent");

    for (const vevent of vevents) {
      try {
        const event = new ICAL.Event(vevent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dtstart = vevent.getFirstPropertyValue("dtstart") as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allDay = dtstart?.isDate === true || (event.startDate as any)?.isDate === true;
        const startDate = event.startDate?.toJSDate?.();
        if (!startDate) continue;
        const endDate = event.endDate?.toJSDate?.() || startDate;

        const rawSummary = event.summary || "Sin título";
        const startIso = startDate.toISOString();
        const uid = event.uid || makeUid(cal.name, startIso, rawSummary);

        // Apply override if present
        const ov = overrides[uid];
        if (ov?.deleted) continue;

        const finalEnd = ov?.end !== undefined ? ov.end : (endDate ? endDate.toISOString() : startIso);

        if (hidePastEvents) {
          const endObj = new Date(finalEnd);
          if (!isNaN(endObj.getTime()) && endObj.getTime() < Date.now()) {
            continue;
          }
        }

        events.push({
          uid,
          summary: ov?.summary !== undefined ? ov.summary : rawSummary,
          start: ov?.start !== undefined ? ov.start : startIso,
          end: finalEnd,
          allDay,
          location: hideLocation ? "" : (ov?.location !== undefined ? ov.location : (event.location || "")),
          url: ov?.url !== undefined ? ov.url : (vevent.getFirstPropertyValue("url") || ""),
          description: ov?.description !== undefined ? ov.description : (event.description || ""),
          calendarId: cal.id,
          calendarName: cal.name,
        });
      } catch {
        // skip malformed events
      }
    }
  } catch {
    // skip malformed ICS
  }
  return events;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const uid = searchParams.get("uid");
  const calId = searchParams.get("calId");

  if (!uid || !calId) {
    return NextResponse.json({ error: "Missing uid or calId" }, { status: 400 });
  }

  try {
    const adminDb = getAdminFirestore();
    const snap = await adminDb.collection("users").doc(uid).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const config = snap.data() as UserConfig;
    const overrides = config.eventOverrides ?? {};
    const hidePastEvents = config.hidePastEvents ?? false;
    const hideLocation = config.hideLocation ?? false;

    // ── All calendars mode ──────────────────────────────────────────────────
    if (calId === "all") {
      const enabledCals = config.calendars.filter((c) => c.enabled);
    const deduplicate = config.deduplicateEvents ?? false;
    const showEmojis = config.showEmojis ?? false;
    let allEvents: RawEvent[] = [];

    await Promise.allSettled(
      enabledCals.map(async (cal) => {
        try {
          const res = await fetch(cal.url, {
            headers: { "User-Agent": "CalSync/2.0" },
            cache: "no-store",
          });
          if (!res.ok) return;
          const text = await res.text();
          allEvents.push(...parseCalendarToRaw(text, cal, overrides, hidePastEvents, hideLocation));
        } catch {
          // skip failing calendars silently
        }
      })
    );

    allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    if (deduplicate) allEvents = deduplicatePreviewEvents(allEvents, showEmojis);
    return NextResponse.json({ calendarName: "Todos los calendarios", events: allEvents });
    }

    // ── Single calendar mode ────────────────────────────────────────────────
    const cal = config.calendars.find((c) => c.id === calId);
    if (!cal) {
      return NextResponse.json({ error: "Calendar not found" }, { status: 404 });
    }

    const res = await fetch(cal.url, {
      headers: { "User-Agent": "CalSync/2.0" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const events = parseCalendarToRaw(text, cal, overrides, hidePastEvents, hideLocation);
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    return NextResponse.json({ calendarName: cal.name, events });
  } catch (err) {
    console.error("[Preview] Error:", err);
    return NextResponse.json({ error: "Failed to fetch calendar" }, { status: 500 });
  }
}
