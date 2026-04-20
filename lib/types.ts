// ─── Shared TypeScript Types ──────────────────────────────────────────────────

export interface CalendarSource {
  id: string;          // UUID generado en el cliente
  name: string;        // Nombre legible del calendario
  url: string;         // URL del .ics
  enabled: boolean;    // Si está activo o no
}

export interface UserConfig {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  calendars: CalendarSource[];
  alert1Minutes: number;  // 0 = desactivado
  alert2Minutes: number;  // 0 = desactivado
  createdAt: number;      // timestamp ms
  updatedAt: number;      // timestamp ms
}

export type AlertOption = {
  label: string;
  value: number;
};

export const ALERT_OPTIONS: AlertOption[] = [
  { label: "Desactivado", value: 0 },
  { label: "Al momento", value: 0.01 }, // special case
  { label: "5 minutos antes", value: 5 },
  { label: "10 minutos antes", value: 10 },
  { label: "15 minutos antes", value: 15 },
  { label: "30 minutos antes", value: 30 },
  { label: "1 hora antes", value: 60 },
  { label: "2 horas antes", value: 120 },
  { label: "1 día antes", value: 1440 },
  { label: "2 días antes", value: 2880 },
];
