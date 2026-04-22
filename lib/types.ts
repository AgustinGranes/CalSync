// ─── Shared TypeScript Types ──────────────────────────────────────────────────

export interface CalendarSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

/** Individual calendar exceptions for formatting */
export interface CalendarException {
  calendarId: string;
  showEmojis?: boolean;
  showCalendarName?: boolean;
}

/** Per-event user overrides, stored by ICS event UID */
export interface EventOverride {
  summary?: string;
  location?: string;
  url?: string;
  description?: string;
  start?: string;
  end?: string;
  deleted?: boolean;
}

export interface UserConfig {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  calendars: CalendarSource[];
  alert1Minutes: number;
  alert2Minutes: number;
  showEmojis: boolean;          // Keep original emojis in titles
  showCalendarName: boolean;    // Prepend CALENDAR: before event title
  deduplicateEvents?: boolean;  // Merge duplicate events across calendars
  hidePastEvents?: boolean;     // Automatically filter out events whose end date has passed
  hideLocation?: boolean;       // Strip LOCATION from all events
  /** Per-calendar formatting overrides */
  calendarExceptions?: CalendarException[];
  /** Per-event field overrides keyed by ICS event UID */
  eventOverrides?: Record<string, EventOverride>;
  createdAt: number;
  updatedAt: number;
}

export type AlertOption = {
  label: string;
  value: number;
};

export const ALERT_OPTIONS: AlertOption[] = [
  { label: "Desactivado", value: 0 },
  { label: "5 minutos antes", value: 5 },
  { label: "10 minutos antes", value: 10 },
  { label: "15 minutos antes", value: 15 },
  { label: "30 minutos antes", value: 30 },
  { label: "1 hora antes", value: 60 },
  { label: "2 horas antes", value: 120 },
  { label: "1 día antes", value: 1440 },
  { label: "2 días antes", value: 2880 },
];
