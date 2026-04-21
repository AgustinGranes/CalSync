import { NextResponse } from "next/server";
// @ts-ignore
import ICAL from "ical.js";
import { getAdminFirestore } from "@/lib/firebase-admin";
import { UserConfig } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── Email via Resend ─────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("[CalSync/notify] RESEND_API_KEY not set");
    return false;
  }
  const from = process.env.FROM_EMAIL ?? "onboarding@resend.dev";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: `CalSync <${from}>`, to: [to], subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("[CalSync/notify] Email error:", err);
    return false;
  }
  return true;
}

// ─── ICS Parser (lightweight) ─────────────────────────────────────────────────

interface SimpleEvent {
  uid: string;
  summary: string;
  start: Date;
}

function parseEventsFromICS(icsText: string): SimpleEvent[] {
  const results: SimpleEvent[] = [];
  try {
    const parsed = ICAL.parse(icsText);
    const comp = new ICAL.Component(parsed);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vevents: any[] = comp.getAllSubcomponents("vevent");
    for (const vevent of vevents) {
      try {
        const event = new ICAL.Event(vevent);
        const uid: string = event.uid;
        const summary: string = event.summary || "Evento";
        const startDate: Date | null = event.startDate?.toJSDate?.() ?? null;
        if (uid && startDate && !isNaN(startDate.getTime())) {
          results.push({ uid, summary, start: startDate });
        }
      } catch {
        // skip malformed event
      }
    }
  } catch {
    // skip malformed ICS
  }
  return results;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Optional cron secret protection
  const secret = searchParams.get("secret");
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional: target a single user (for testing)
  const targetUid = searchParams.get("uid");

  const adminDb = getAdminFirestore();
  const now = Date.now();
  const results: { uid: string; sent: number; skipped: number }[] = [];

  // Load users with email notifications enabled
  let query = adminDb.collection("users").where("emailNotifications", "==", true);
  const usersSnap = await query.get();

  for (const userDoc of usersSnap.docs) {
    if (targetUid && userDoc.id !== targetUid) continue;

    const config = userDoc.data() as UserConfig & {
      sentNotifications?: Record<string, number>;
    };

    const email = config.notificationEmail || config.email;
    if (!email) continue;

    const alert1 = config.alert1Minutes ?? 15;
    const alert2 = config.alert2Minutes ?? 5;
    const alertTimes = [...new Set([alert1, alert2].filter((m) => m > 0))];
    const enabledCals = (config.calendars || []).filter((c) => c.enabled);

    // Load & clean sent-notifications map
    const sentNotifications: Record<string, number> = { ...(config.sentNotifications ?? {}) };
    for (const key of Object.keys(sentNotifications)) {
      if (now - sentNotifications[key] > 48 * 60 * 60 * 1000) {
        delete sentNotifications[key];
      }
    }

    let sent = 0;
    let skipped = 0;

    for (const cal of enabledCals) {
      try {
        const res = await fetch(cal.url, {
          headers: { "User-Agent": "CalSync-Notify/1.0" },
          cache: "no-store",
        });
        if (!res.ok) continue;
        const text = await res.text();
        const events = parseEventsFromICS(text);

        for (const ev of events) {
          for (const alertMin of alertTimes) {
            const notifKey = `${ev.uid}:${alertMin}`;
            if (sentNotifications[notifKey]) { skipped++; continue; }

            // Check if this event starts in alertMin minutes (±30s tolerance)
            const targetMs = ev.start.getTime() - alertMin * 60 * 1000;
            if (Math.abs(now - targetMs) > 30_000) continue;

            // Build email
            const timeStr = ev.start.toLocaleString("es-AR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            });
            const html = `
              <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;background:#1a1a2e;color:#e2e2ff;border-radius:12px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px;">
                  <h1 style="margin:0;font-size:22px;color:#fff;">⏰ En ${alertMin} minutos</h1>
                </div>
                <div style="padding:24px;">
                  <h2 style="margin:0 0 8px;font-size:18px;color:#a5b4fc;">${ev.summary}</h2>
                  <p style="margin:0 0 16px;color:#c4c4f0;">📅 ${timeStr}</p>
                  <p style="margin:0;color:#888;font-size:11px;">Calendario: ${cal.name} · CalSync</p>
                </div>
              </div>
            `;

            const ok = await sendEmail(email, `⏰ En ${alertMin} min: ${ev.summary}`, html);
            if (ok) {
              sentNotifications[notifKey] = now;
              sent++;
            }
          }
        }
      } catch (err) {
        console.error("[CalSync/notify] Calendar fetch error:", err);
      }
    }

    // Persist updated sentNotifications
    await adminDb.collection("users").doc(userDoc.id).update({ sentNotifications });
    results.push({ uid: userDoc.id, sent, skipped });
  }

  return NextResponse.json({ ok: true, processed: usersSnap.size, results });
}
