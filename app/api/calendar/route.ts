import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      error: "Este endpoint ya no es público.",
      info: "Tu enlace personal es /api/calendar/{tu-uid}. Iniciá sesión en la app para obtenerlo.",
      app: "https://calendario-eosin.vercel.app",
    },
    { status: 410 }
  );
}
