import { NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase-admin";
import { UserConfig } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ uid: string }> }
) {
  const { uid } = await params;

  try {
    const adminDb = getAdminFirestore();
    const snap = await adminDb.collection("users").doc(uid).get();
    if (!snap.exists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const data = snap.data() as UserConfig;

    return NextResponse.json({
      displayName: data.displayName || data.email || "Usuario",
      // Only expose enabled calendars with name + url (not IDs)
      calendars: (data.calendars || [])
        .filter((c) => c.enabled)
        .map((c) => ({ id: c.id, name: c.name, url: c.url })),
    });
  } catch (err) {
    console.error("[User API] Error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
