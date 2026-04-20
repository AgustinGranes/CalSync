import { NextResponse } from "next/server";
// @ts-ignore
import ICAL from "ical.js";
import { getAdminFirestore } from "@/lib/firebase-admin";
import { UserConfig } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export interface RawEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
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

    // Parse ICS
    const events: RawEvent[] = [];
    const parsed = ICAL.parse(text);
    const comp = new ICAL.Component(parsed);
    const vevents: ICAL.Component[] = comp.getAllSubcomponents("vevent");

    for (const vevent of vevents) {
      try {
        const event = new ICAL.Event(vevent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dtstart = vevent.getFirstPropertyValue("dtstart") as any;
        const allDay = dtstart?.isDate === true || (event.startDate as any)?.isDate === true;
        const startDate = event.startDate?.toJSDate?.();
        if (!startDate) continue;
        const endDate = event.endDate?.toJSDate?.() || startDate;

        events.push({
          summary: event.summary || "Sin título",
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          allDay,
          location: event.location || "",
        });
      } catch {
        // skip malformed events
      }
    }

    // Sort by start date ascending
    events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    return NextResponse.json({
      calendarName: cal.name,
      events,
    });
  } catch (err) {
    console.error("[Preview] Error:", err);
    return NextResponse.json({ error: "Failed to fetch calendar" }, { status: 500 });
  }
}
