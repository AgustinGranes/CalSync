"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { UserConfig, CalendarSource, ALERT_OPTIONS, EventOverride, CalendarException } from "@/lib/types";
import styles from "./page.module.css";

/* --- Helper types ------------------------------------------------------------- */

interface RawEvent {
  uid: string;
  summary: string;     // raw (before formatting); already has override applied from API
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  url: string;
  description: string;
  calendarId: string;
  calendarName: string;
}

interface DayGroup {
  key: string;
  label: string;
  events: RawEvent[];
}

interface ExternalCalData {
  displayName: string;
  calendars: { id: string; name: string; url: string }[];
}

/* --- Helper functions --------------------------------------------------------- */

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function stripEmojisClient(str: string): string {
  if (!str) return str;
  return str
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[\u200D\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatEventTitle(
  rawSummary: string,
  calName: string,
  showEmojis: boolean,
  showCalName: boolean,
  calendarId?: string,
  exceptions?: CalendarException[]
): string {
  // Check for calendar-specific exception
  const exc = exceptions?.find((e) => e.calendarId === calendarId);
  const finalShowEmojis = exc?.showEmojis !== undefined ? exc.showEmojis : showEmojis;
  const finalShowCalName = exc?.showCalendarName !== undefined ? exc.showCalendarName : showCalName;

  const title = finalShowEmojis ? rawSummary : stripEmojisClient(rawSummary);
  if (finalShowCalName) {
    const prefix = (finalShowEmojis ? calName : stripEmojisClient(calName)).toUpperCase().trim();
    return `${prefix}: ${title}`;
  }
  return title;
}

/* --- Marquee Component ------------------------------------------------------ */

function MarqueeTitle({ title }: { title: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [shouldScroll, setShouldScroll] = useState(false);
  const [scrollDuration, setScrollDuration] = useState(0);

  useEffect(() => {
    if (containerRef.current && textRef.current) {
      const containerWidth = containerRef.current.offsetWidth;
      const textWidth = textRef.current.offsetWidth;
      
      if (textWidth > containerWidth) {
        setShouldScroll(true);
        // Add 40 to account for the padding added by marqueeTextScroll
        setScrollDuration((textWidth + 40) / 40); // 40px/s
      } else {
        setShouldScroll(false);
      }
    }
  }, [title]);

  return (
    <div ref={containerRef} className={styles.marqueeContainer}>
      <div 
        className={`${styles.marqueeTrack} ${shouldScroll ? styles.marqueeAnimateInfinite : ""}`}
        style={{ "--duration": `${scrollDuration}s` } as any}
      >
        <span ref={textRef} className={`${styles.marqueeText} ${shouldScroll ? styles.marqueeTextScroll : ""}`}>
          {title}
        </span>
        {shouldScroll && (
          <span className={`${styles.marqueeText} ${styles.marqueeTextScroll}`}>
            {title}
          </span>
        )}
      </div>
    </div>
  );
}

function groupEventsByDay(events: RawEvent[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const ev of events) {
    const d = new Date(ev.start);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const key = `${year}-${month}-${day}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: d.toLocaleDateString("es-AR", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }).toUpperCase(),
        events: [],
      });
    }
    map.get(key)!.events.push(ev);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDatetime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    + " " + d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function toDatetimeLocal(isoStr: string): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DEFAULT_CONFIG_FIELDS = {
  calendars: [] as CalendarSource[],
  alert1Minutes: 15,
  alert2Minutes: 5,
  showEmojis: false,
  showCalendarName: true,
  deduplicateEvents: false,
  hidePastEvents: false,
  hideLocation: false,
  eventOverrides: {} as Record<string, EventOverride>,
  calendarExceptions: [] as CalendarException[],
  updatedAt: Date.now(),
};

/* --- Component ---------------------------------------------------------------- */

export default function Dashboard() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Core
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  const [toastType, setToastType] = useState<"success" | "error">("success");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: "success" | "error" = "success") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    setToastType(type);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // Calendar form
  const [newCalName, setNewCalName] = useState("");
  const [newCalUrl, setNewCalUrl] = useState("");
  const [addingCal, setAddingCal] = useState(false);
  const [addError, setAddError] = useState("");

  // Edit calendar modal
  const [editingCal, setEditingCal] = useState<CalendarSource | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editingCalException, setEditingCalException] = useState<CalendarException | null>(null);

  // Exceptions modal
  const [exceptionsOpen, setExceptionsOpen] = useState(false);
  const [addingException, setAddingException] = useState(false);
  const [newExcCalId, setNewExcCalId] = useState("");
  const [newExcEmojis, setNewExcEmojis] = useState(false);
  const [newExcName, setNewExcName] = useState(true);
  const [newExcHideLoc, setNewExcHideLoc] = useState(false);

  // Collapsible calendar section
  const [calsExpanded, setCalsExpanded] = useState(false);

  // ── Event preview modal (single calendar OR all) ──────────────────────────
  const [previewCalId, setPreviewCalId] = useState<string>("all");
  const [previewCalName, setPreviewCalName] = useState<string>("");
  const [previewGroups, setPreviewGroups] = useState<DayGroup[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  // ── Edit individual event override ────────────────────────────────────────
  const [editingEvent, setEditingEvent] = useState<RawEvent | null>(null);
  const [editEvFields, setEditEvFields] = useState({
    summary: "", location: "", url: "", description: "", start: "", end: ""
  });

  // Share/Receive
  const [receivePopup, setReceivePopup] = useState(false);
  const [receiveUrl, setReceiveUrl] = useState("");
  const [externalData, setExternalData] = useState<ExternalCalData | null>(null);
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState("");
  const [selectedExtIds, setSelectedExtIds] = useState<Set<string>>(new Set());

  // ── Edit Mode & Pending Changes ───────────────────────────────────────────
  const [isEditMode, setIsEditMode] = useState(false);
  const [pendingOverrides, setPendingOverrides] = useState<Record<string, EventOverride>>({});
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);


  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.keys(pendingOverrides).length > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [pendingOverrides]);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (!loading && !user) router.push("/");
  }, [user, loading, router]);

  /* --- Load config --------------------------------------------------------- */

  const loadConfig = useCallback(async () => {
    if (!user) return;
    setConfigError(null);
    try {
      const ref = doc(db, "users", user.uid);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const data = snap.data() as UserConfig;
        setConfig({ ...DEFAULT_CONFIG_FIELDS, ...data });
      } else {
        const newConfig: UserConfig = {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
          ...DEFAULT_CONFIG_FIELDS,
          createdAt: Date.now(),
        };
        await setDoc(ref, newConfig);
        setConfig(newConfig);
      }
    } catch (err: unknown) {
      console.error("[CalSync] Firestore load error:", err);
      const code = (err as { code?: string })?.code ?? "";
      if (code === "permission-denied") {
        setConfigError("Sin permisos para leer la base de datos. Verificá las reglas de Firestore.");
      } else if (code === "unavailable" || code === "deadline-exceeded") {
        setConfigError("No se pudo conectar a la base de datos. Verificá tu conexión.");
      } else {
        setConfigError(`Error al cargar la configuración: ${code || "desconocido"}`);
      }
    }
  }, [user]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  /* --- Save config --------------------------------------------------------- */

  const saveConfig = async (newCfg: UserConfig, toastMsg = "Guardado") => {
    if (!user) return;
    setSaving(true);
    const updated = { ...newCfg, updatedAt: Date.now() };
    try {
      await setDoc(doc(db, "users", user.uid), updated);
      setConfig(updated);
      showToast(`✓ ${toastMsg}`);
    } catch (err) {
      console.error("[CalSync] Save error:", err);
      showToast("✗ Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  /* --- Derived ------------------------------------------------------------- */

  if (loading || (!config && !configError)) {
    return (
      <div className={styles.loadingFullscreen}>
        <div className={styles.loadingBrand}>
          <svg className={styles.loadingLogo} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <rect x="4" y="8" width="32" height="28" rx="5" fill="url(#ldg1)" />
            <rect x="4" y="8" width="32" height="10" rx="5" fill="url(#ldg2)" />
            <rect x="4" y="14" width="32" height="4" fill="url(#ldg2)" />
            <circle cx="13" cy="27" r="2.5" fill="white" fillOpacity=".9" />
            <circle cx="20" cy="27" r="2.5" fill="white" fillOpacity=".6" />
            <circle cx="27" cy="27" r="2.5" fill="white" fillOpacity=".3" />
            <line x1="12" y1="4" x2="12" y2="12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="28" y1="4" x2="28" y2="12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
            <defs>
              <linearGradient id="ldg1" x1="4" y1="8" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                <stop stopColor="#7C3AED" /><stop offset="1" stopColor="#2563EB" />
              </linearGradient>
              <linearGradient id="ldg2" x1="4" y1="8" x2="36" y2="18" gradientUnits="userSpaceOnUse">
                <stop stopColor="#5B21B6" /><stop offset="1" stopColor="#1D4ED8" />
              </linearGradient>
            </defs>
          </svg>
          <span className={styles.loadingLogoText}>CalSync</span>
          <span className={styles.spinner} />
        </div>
      </div>
    );
  }

  if (configError) {
    return (
      <main className={styles.main}>
        <div className={styles.blobPurple} aria-hidden />
        <div className={styles.blobBlue} aria-hidden />
        <div className={styles.loadingCenter}>
          <div className={styles.errorBox}>
            <p className={styles.errorTitle}>Error al cargar</p>
            <p className={styles.errorMsg}>{configError}</p>
            <button className={styles.btnRetry} onClick={loadConfig}>Reintentar</button>
            <button className={styles.btnRetrySecondary} onClick={() => signOut(auth)}>
              Cerrar sesión
            </button>
          </div>
        </div>
      </main>
    );
  }

  const cfg = config!;
  const showEmojis = cfg.showEmojis ?? false;
  const showCalName = cfg.showCalendarName ?? true;
  const deduplicateEvents = cfg.deduplicateEvents ?? false;
  const hidePastEvents = cfg.hidePastEvents ?? false;
  const hideLocation = cfg.hideLocation ?? false;
  const sampleEvent = "🏎️ Gran premio de Melbourne";
  const previewTitle = formatEventTitle(
    sampleEvent,
    "Formula 1",
    showEmojis,
    showCalName,
    undefined,
    cfg.calendarExceptions
  );
  const webcalUrl = origin ? `webcal://${origin.replace(/^https?:\/\//, "")}/api/calendar/${cfg.uid}` : "";
  const httpsUrl = origin ? `${origin}/api/calendar/${cfg.uid}` : "";

  /* --- Calendar link actions ------------------------------------------------ */

  const handleSubscribe = () => { if (webcalUrl) window.open(webcalUrl, "_blank"); };
  const handleCopy = async () => {
    if (!httpsUrl) return;
    await navigator.clipboard.writeText(httpsUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const handleLogout = () => signOut(auth);

  /* --- Calendar CRUD -------------------------------------------------------- */

  const handleAddCalendar = async () => {
    if (!config) return;
    setAddError("");
    const name = newCalName.trim();
    const url = newCalUrl.trim();
    if (!name) { setAddError("El nombre no puede estar vacío."); return; }
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("webcal://"))) {
      setAddError("Ingresá una URL válida (http:// o https://).");
      return;
    }
    const normalized = url.replace(/^webcal:\/\//, "https://");
    const newCal: CalendarSource = { id: generateId(), name, url: normalized, enabled: true };
    await saveConfig({ ...config, calendars: [...config.calendars, newCal] }, "Calendario agregado");
    setNewCalName(""); setNewCalUrl(""); setAddingCal(false);
  };

  const handleToggleCalendar = async (id: string) => {
    if (!config) return;
    await saveConfig({
      ...config,
      calendars: config.calendars.map((c) => c.id === id ? { ...c, enabled: !c.enabled } : c),
    }, "Guardado");
  };

  const handleDeleteCalendar = async (id: string) => {
    if (!config) return;
    await saveConfig({
      ...config,
      calendars: config.calendars.filter((c) => c.id !== id),
    }, "Calendario eliminado");
  };

  const handleOpenEditCal = (cal: CalendarSource) => {
    setEditingCal(cal); setEditName(cal.name); setEditUrl(cal.url);
  };

  const handleSaveEditCal = async () => {
    if (!config || !editingCal) return;
    await saveConfig({
      ...config,
      calendars: config.calendars.map((c) =>
        c.id === editingCal.id ? { ...c, name: editName.trim(), url: editUrl.trim() } : c
      ),
    }, "Cambios guardados");
    setEditingCal(null);
  };

  /* --- Alert settings ------------------------------------------------------- */

  const handleAlertChange = async (field: "alert1Minutes" | "alert2Minutes", value: number) => {
    if (!config) return;
    const updated = { ...config, [field]: value };
    setConfig(updated);
    await saveConfig(updated, "Alerta actualizada");
  };

  /* --- Format settings ------------------------------------------------------ */

  const handleToggleFormat = async (field: "showEmojis" | "showCalendarName" | "deduplicateEvents" | "hidePastEvents" | "hideLocation") => {
    if (!config) return;
    const updated = { ...config, [field]: !config[field] };
    setConfig(updated);
    await saveConfig(updated, "Formato actualizado");
  };

  /* --- Event preview (single calendar or all) ------------------------------- */

  const openPreview = async (calId: string, calName: string) => {
    setPreviewOpen(true);
    setPreviewCalId(calId);
    setPreviewCalName(calName);
    setPreviewGroups([]);
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/preview?uid=${user?.uid}&calId=${calId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPreviewGroups(groupEventsByDay(data.events));
    } catch (err) {
      setPreviewError((err as Error).message || "Error al cargar eventos");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleOpenPreview = (cal: CalendarSource) => openPreview(cal.id, cal.name);
  const handleOpenAllCalendars = () => openPreview("all", "Todos los calendarios");

  const closePreview = () => {
    if (Object.keys(pendingOverrides).length > 0) {
      setPendingAction(() => () => {
        setPreviewOpen(false);
        setPreviewGroups([]);
        setEditingEvent(null);
        setIsEditMode(false);
        setPendingOverrides({});
      });
      setShowExitConfirm(true);
      return;
    }
    setPreviewOpen(false);
    setPreviewGroups([]);
    setEditingEvent(null);
    setIsEditMode(false);
    setPendingOverrides({});
  };

  /* --- Edit individual event override -------------------------------------- */

  const handleOpenEditEvent = (ev: RawEvent) => {
    setEditingEvent(ev);
    setEditEvFields({
      summary: ev.summary,
      location: ev.location,
      url: ev.url,
      description: ev.description,
      start: toDatetimeLocal(ev.start),
      end: toDatetimeLocal(ev.end),
    });
  };

  const handleSaveEventOverride = async () => {
    if (!editingEvent || !config) return;

    const newOverride: EventOverride = {};
    if (editEvFields.summary !== undefined) newOverride.summary = editEvFields.summary;
    if (editEvFields.location !== undefined) newOverride.location = editEvFields.location;
    if (editEvFields.url !== undefined) newOverride.url = editEvFields.url;
    if (editEvFields.description !== undefined) newOverride.description = editEvFields.description;

    if (editEvFields.start) newOverride.start = new Date(editEvFields.start).toISOString();
    if (editEvFields.end) newOverride.end = new Date(editEvFields.end).toISOString();

    if (isEditMode) {
      setPendingOverrides(prev => ({ ...prev, [editingEvent.uid]: newOverride }));
      setEditingEvent(null);
    } else {
      const currentOverrides = config.eventOverrides ?? {};
      const updatedOverrides = { ...currentOverrides, [editingEvent.uid]: newOverride };
      await saveConfig({ ...config, eventOverrides: updatedOverrides }, "Evento actualizado");
      setEditingEvent(null);
      await openPreview(previewCalId, previewCalName).catch(() => { });
    }
  };

  const handleDeleteEventOverride = async (ev: RawEvent) => {
    if (!config) return;

    const isCurrentlyDeleted = (pendingOverrides[ev.uid]?.deleted !== undefined) 
      ? pendingOverrides[ev.uid].deleted 
      : config.eventOverrides?.[ev.uid]?.deleted;

    if (isEditMode) {
      const current = pendingOverrides[ev.uid] || config.eventOverrides?.[ev.uid] || {};
      setPendingOverrides(prev => ({ ...prev, [ev.uid]: { ...current, deleted: !isCurrentlyDeleted } }));
      if (editingEvent?.uid === ev.uid) setEditingEvent(null);
    } else {
      const currentOverrides = config.eventOverrides ?? {};
      const current = currentOverrides[ev.uid] || {};
      const updatedOverrides = { ...currentOverrides, [ev.uid]: { ...current, deleted: !isCurrentlyDeleted } };
      await saveConfig({ ...config, eventOverrides: updatedOverrides }, isCurrentlyDeleted ? "Evento restaurado" : "Evento eliminado");
      if (editingEvent?.uid === ev.uid) setEditingEvent(null);
      await openPreview(previewCalId, previewCalName).catch(() => { });
    }
  };

  const handleResetEventOverride = async () => {
    if (!editingEvent || !config) return;
    if (isEditMode) {
      setPendingOverrides(prev => {
        const next = { ...prev };
        delete next[editingEvent.uid];
        return next;
      });
      setEditingEvent(null);
    } else {
      const updated = { ...config.eventOverrides };
      delete updated[editingEvent.uid];
      await saveConfig({ ...config, eventOverrides: updated }, "Evento restaurado");
      setEditingEvent(null);
      await openPreview(previewCalId, previewCalName).catch(() => { });
    }
  };

  const handleSaveAllChanges = async () => {
    if (!config) return;
    const currentOverrides = config.eventOverrides ?? {};
    const updatedOverrides = { ...currentOverrides, ...pendingOverrides };
    await saveConfig({ ...config, eventOverrides: updatedOverrides }, "Cambios guardados");
    setPendingOverrides({});
    setIsEditMode(false);
    await openPreview(previewCalId, previewCalName).catch(() => { });
  };

  const handleCancelEdit = () => {
    if (Object.keys(pendingOverrides).length > 0) {
      setPendingAction(() => () => {
        setIsEditMode(false);
        setPendingOverrides({});
      });
      setShowExitConfirm(true);
    } else {
      setIsEditMode(false);
    }
  };

  /* --- Calendar Exceptions -------------------------------------------------- */

  const handleOpenAddException = () => {
    setAddingException(true);
    setEditingCalException(null);
    // Default to first calendar not already in exceptions
    const existingIds = new Set((config?.calendarExceptions || []).map(e => e.calendarId));
    const available = (config?.calendars || []).filter(c => !existingIds.has(c.id));
    if (available.length > 0) {
      setNewExcCalId(available[0].id);
    } else {
      setNewExcCalId("");
    }
    setNewExcEmojis(config?.showEmojis ?? false);
    setNewExcName(config?.showCalendarName ?? true);
    setNewExcHideLoc(config?.hideLocation ?? false);
  };

  const handleOpenEditException = (exc: CalendarException) => {
    setEditingCalException(exc);
    setNewExcCalId(exc.calendarId);
    setNewExcEmojis(exc.showEmojis ?? config?.showEmojis ?? false);
    setNewExcName(exc.showCalendarName ?? config?.showCalendarName ?? true);
    setNewExcHideLoc(exc.hideLocation ?? config?.hideLocation ?? false);
    setAddingException(true);
  };

  const handleSaveException = async () => {
    if (!config || !newExcCalId) return;
    const current = config.calendarExceptions || [];
    let updated: CalendarException[];

    if (editingCalException) {
      updated = current.map(e => e.calendarId === editingCalException.calendarId ? { ...e, showEmojis: newExcEmojis, showCalendarName: newExcName, hideLocation: newExcHideLoc } : e);
    } else {
      // Check if already exists
      if (current.some(e => e.calendarId === newExcCalId)) {
        showToast("Este calendario ya tiene una excepción", "error");
        return;
      }
      updated = [...current, { calendarId: newExcCalId, showEmojis: newExcEmojis, showCalendarName: newExcName, hideLocation: newExcHideLoc }];
    }

    await saveConfig({ ...config, calendarExceptions: updated }, "Excepción guardada");
    setAddingException(false);
    setEditingCalException(null);
  };

  const handleDeleteException = async (calId: string) => {
    if (!config) return;
    const updated = (config.calendarExceptions || []).filter(e => e.calendarId !== calId);
    await saveConfig({ ...config, calendarExceptions: updated }, "Excepción eliminada");
  };

  /* --- Share / Receive ------------------------------------------------------ */

  const handleShare = async () => {
    if (!user || !origin) return;
    const link = `${origin}/api/calendar/${user.uid}`;
    const name = cfg.displayName || cfg.email || user.uid;
    const msg = `¡Seleccioná los calendarios que quieras de el CalSync de ${name}! (Copia el enlace al portapapeles): ${link}`;
    await navigator.clipboard.writeText(msg);
    showToast("✓ Enlace copiado al portapapeles");
  };

  const handleReceiveInit = async () => {
    setExternalData(null);
    setExternalError("");
    setSelectedExtIds(new Set());
    setReceiveUrl("");
    setReceivePopup(true);
    try {
      const text = await navigator.clipboard.readText();
      if (text.includes("/api/calendar/")) {
        setReceiveUrl(text.trim());
        await lookupCalSync(text.trim());
      }
    } catch {
      // Clipboard may be denied — user can paste manually
    }
  };

  const lookupCalSync = async (urlOrText: string) => {
    setExternalData(null);
    setExternalError("");
    setExternalLoading(true);
    try {
      const match = urlOrText.match(/\/api\/calendar\/([a-zA-Z0-9_-]+)/);
      if (!match) { setExternalError("No contiene un enlace CalSync válido."); return; }
      const uid = match[1];
      if (uid === user?.uid) { setExternalError("No podés importar tu propio CalSync."); return; }
      const res = await fetch(`/api/user/${uid}`);
      if (!res.ok) { setExternalError("No se encontró ese CalSync."); return; }
      const data: ExternalCalData = await res.json();
      if (!data.calendars || data.calendars.length === 0) {
        setExternalError("Este CalSync está vacío o no tiene calendarios activos.");
        return;
      }
      const existingUrls = new Set((config?.calendars || []).map((c) => c.url));
      const pre = new Set<string>();
      for (const cal of data.calendars) {
        if (existingUrls.has(cal.url)) pre.add(cal.id);
      }
      setExternalData(data);
      setSelectedExtIds(pre);
    } catch {
      setExternalError("Error al buscar el CalSync. Intentá de nuevo.");
    } finally {
      setExternalLoading(false);
    }
  };

  const toggleExtId = (id: string) => {
    setSelectedExtIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleSaveExternal = async () => {
    if (!externalData || !config) return;
    const existingUrls = new Set(config.calendars.map((c) => c.url));
    const toAdd = externalData.calendars
      .filter((c) => selectedExtIds.has(c.id) && !existingUrls.has(c.url))
      .map((c) => ({ id: generateId(), name: c.name, url: c.url, enabled: true }));

    if (toAdd.length > 0) {
      await saveConfig(
        { ...config, calendars: [...config.calendars, ...toAdd] },
        "Calendarios guardados"
      );
    } else {
      showToast("✗ No hay cambios nuevos", "error");
    }
    setReceivePopup(false);
    setExternalData(null);
  };

  /* --- Render --------------------------------------------------------------- */

  return (
    <main className={styles.main}>
      <div className={styles.blobPurple} aria-hidden />
      <div className={styles.blobBlue} aria-hidden />
      <div className={styles.blobTeal} aria-hidden />

      <div className={styles.container}>

        <header className={styles.topBar}>
          <div className={styles.logoWrap}>
            <svg className={styles.logoIcon} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
              <rect x="4" y="8" width="32" height="28" rx="5" fill="url(#dg1)" />
              <rect x="4" y="8" width="32" height="10" rx="5" fill="url(#dg2)" />
              <rect x="4" y="14" width="32" height="4" fill="url(#dg2)" />
              <circle cx="13" cy="27" r="2.5" fill="white" fillOpacity=".9" />
              <circle cx="20" cy="27" r="2.5" fill="white" fillOpacity=".6" />
              <circle cx="27" cy="27" r="2.5" fill="white" fillOpacity=".3" />
              <line x1="12" y1="4" x2="12" y2="12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="28" y1="4" x2="28" y2="12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
              <defs>
                <linearGradient id="dg1" x1="4" y1="8" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#7C3AED" /><stop offset="1" stopColor="#2563EB" />
                </linearGradient>
                <linearGradient id="dg2" x1="4" y1="8" x2="36" y2="18" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#5B21B6" /><stop offset="1" stopColor="#1D4ED8" />
                </linearGradient>
              </defs>
            </svg>
            <span className={styles.logoText}>CalSync</span>
          </div>
          <div className={styles.userSection}>
            {cfg.photoURL && (
              <img src={cfg.photoURL} alt={cfg.displayName || "Usuario"} className={styles.avatar} />
            )}
            <button id="btn-logout" className={styles.btnLogout} onClick={handleLogout} aria-label="Cerrar sesión">
              Salir
            </button>
          </div>
        </header>

        <section className={styles.card} aria-label="Tu enlace personal">
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrap}>
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Tu enlace personal</h2>
              <p className={styles.cardDesc}>Suscribite desde cualquier app de calendario</p>
            </div>
          </div>
          <div className={styles.urlBox}>
            <svg viewBox="0 0 20 20" fill="none" width="15" height="15" aria-hidden>
              <path d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" fill="currentColor" />
            </svg>
            <span className={styles.urlText}>{httpsUrl || "Cargando..."}</span>
          </div>
          <div className={styles.actions}>
            <button id="btn-subscribe" className={styles.btnPrimary} onClick={handleSubscribe} disabled={!webcalUrl}>
              <svg viewBox="0 0 20 20" fill="none" width="17" height="17" aria-hidden>
                <path d="M10 3a7 7 0 100 14A7 7 0 0010 3zm-1 4a1 1 0 112 0v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2V7z" fill="currentColor" />
              </svg>
              Suscribirse
            </button>
            <button id="btn-copy" className={`${styles.btnSecondary} ${copied ? styles.btnSuccess : ""}`} onClick={handleCopy}>
              {copied ? "¡Copiado! ✓" : "Copiar enlace"}
            </button>
          </div>
          <p className={styles.cardNote}>
            Pegá este enlace en Apple Calendario, Google Calendar o cualquier app compatible con WebCal.
          </p>
        </section>

        <section className={styles.card} aria-label="Gestión de calendarios">

          {/* Header row: toggle button + "Ver todo" button */}
          <div className={styles.collapsibleHeaderRow}>
            <button
              className={styles.collapsibleToggle}
              onClick={() => setCalsExpanded((v) => !v)}
              aria-expanded={calsExpanded}
            >
              <div className={styles.cardHeaderInner}>
                <div className={styles.cardIconWrap}>
                  <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                    <path d="M8 2v3M16 2v3M3.5 9.09h17M21 8.5V17c0 3-1.5 5-5 5H8c-3.5 0-5-2-5-5V8.5c0-3 1.5-5 5-5h8c3.5 0 5 2 5 5z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className={styles.collapsibleTitleWrap}>
                  <span className={styles.cardTitle}>Mis calendarios</span>
                  <span className={styles.cardDesc}>
                    {cfg.calendars.length === 0
                      ? "Sin calendarios configurados"
                      : `${cfg.calendars.filter((c) => c.enabled).length} de ${cfg.calendars.length} activos`}
                  </span>
                </div>
              </div>
              <svg
                className={`${styles.chevron} ${calsExpanded ? styles.chevronOpen : ""}`}
                viewBox="0 0 24 24" fill="none" width="20" height="20" aria-hidden
              >
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* "Ver calendario completo" — always visible */}
            <button
              className={styles.btnViewAll}
              onClick={handleOpenAllCalendars}
              title="Ver todos los eventos de todos los calendarios"
            >
              <svg viewBox="0 0 20 20" fill="none" width="15" height="15" aria-hidden>
                <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" fill="currentColor" />
                <path d="M2.458 12C3.732 7.943 6.523 5 10 5c3.477 0 6.268 2.943 7.542 7-1.274 4.057-4.065 7-7.542 7-3.477 0-6.268-2.943-7.542-7z" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              Ver todo
            </button>
          </div>

          {/* Body — collapsible (single direct child for grid trick) */}
          <div className={`${styles.collapsibleBody} ${calsExpanded ? styles.collapsibleBodyOpen : ""}`}>
            <div className={styles.collapsibleBodyInner}>
              {cfg.calendars.length > 0 && (
                <ul className={styles.calList} aria-label="Lista de calendarios">
                  {cfg.calendars.map((cal) => (
                    <li key={cal.id} className={`${styles.calItem} ${!cal.enabled ? styles.calItemDisabled : ""}`}>
                      <div className={styles.calItemLeft}>
                        <button
                          className={`${styles.toggleBtn} ${cal.enabled ? styles.toggleOn : styles.toggleOff}`}
                          onClick={() => handleToggleCalendar(cal.id)}
                          aria-label={cal.enabled ? "Desactivar calendario" : "Activar calendario"}
                        >
                          <span className={styles.toggleThumb} />
                        </button>
                        <div className={styles.calInfo}>
                          <button className={styles.calNameBtn} onClick={() => handleOpenPreview(cal)}>
                            {cal.name}
                          </button>
                          <span className={styles.calUrl}>{cal.url.replace(/^https?:\/\//, "")}</span>
                        </div>
                      </div>
                      <div className={styles.calActions}>
                        <button className={styles.iconBtn} onClick={() => handleOpenEditCal(cal)} aria-label={`Editar ${cal.name}`} title="Editar">
                          <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
                            <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" fill="currentColor" />
                          </svg>
                        </button>
                        <button className={`${styles.iconBtn} ${styles.iconBtnDanger}`} onClick={() => handleDeleteCalendar(cal.id)} aria-label={`Eliminar ${cal.name}`} title="Eliminar">
                          <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
                            <path d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 112 0v6a1 1 0 11-2 0V8z" fill="currentColor" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {addingCal ? (
                <div className={styles.addForm}>
                  <div className={styles.formField}>
                    <label className={styles.label} htmlFor="cal-name">Nombre del calendario</label>
                    <input id="cal-name" className={styles.input} type="text" placeholder="ej: Personal, Trabajo, Formula 1" value={newCalName} onChange={(e) => setNewCalName(e.target.value)} autoFocus />
                  </div>
                  <div className={styles.formField}>
                    <label className={styles.label} htmlFor="cal-url">URL del calendario (.ics)</label>
                    <input id="cal-url" className={styles.input} type="url" placeholder="https://... o webcal://..." value={newCalUrl} onChange={(e) => setNewCalUrl(e.target.value)} />
                  </div>
                  {addError && <p className={styles.error}>{addError}</p>}
                  <div className={styles.formActions}>
                    <button id="btn-confirm-add" className={styles.btnPrimary} onClick={handleAddCalendar} disabled={saving}>
                      {saving ? "Guardando..." : "Agregar calendario"}
                    </button>
                    <button className={styles.btnSecondary} onClick={() => { setAddingCal(false); setAddError(""); }}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <button id="btn-add-calendar" className={styles.btnAddCal} onClick={() => setAddingCal(true)}>
                  <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden>
                    <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" fill="currentColor" />
                  </svg>
                  Agregar calendario
                </button>
              )}
            </div>
          </div>
        </section>

        <section className={styles.card} aria-label="Ajustes de Eventos">
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrap}>
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Ajustes de Eventos</h2>
              <p className={styles.cardDesc}>Cómo aparecen los eventos en tu calendario</p>
            </div>
          </div>

          <ul className={styles.calList}>
            <li className={styles.calItem}>
              <div className={styles.calItemLeft}>
                <button
                  className={`${styles.toggleBtn} ${!showEmojis ? styles.toggleOn : styles.toggleOff}`}
                  onClick={() => handleToggleFormat("showEmojis")}
                  aria-label="Eliminar emojis en títulos"
                >
                  <span className={styles.toggleThumb} />
                </button>
                <div className={styles.calInfo}>
                  <span className={styles.calName}>Eliminar emojis en el título</span>
                  <span className={styles.calUrlFull}>Elimina automáticamente los emojis en los eventos</span>
                </div>
              </div>
            </li>
            <li className={styles.calItem}>
              <div className={styles.calItemLeft}>
                <button
                  className={`${styles.toggleBtn} ${showCalName ? styles.toggleOn : styles.toggleOff}`}
                  onClick={() => handleToggleFormat("showCalendarName")}
                  aria-label="Mostrar nombre del calendario"
                >
                  <span className={styles.toggleThumb} />
                </button>
                <div className={styles.calInfo}>
                  <span className={styles.calName}>Mostrar nombre del calendario</span>
                  <span className={styles.calUrlFull}>Prefija cada evento con el nombre del calendario</span>
                </div>
              </div>
            </li>
            <li className={styles.calItem}>
              <div className={styles.calItemLeft}>
                <button
                  className={`${styles.toggleBtn} ${deduplicateEvents ? styles.toggleOn : styles.toggleOff}`}
                  onClick={() => handleToggleFormat("deduplicateEvents")}
                  aria-label="Eliminar eventos repetidos"
                >
                  <span className={styles.toggleThumb} />
                </button>
                <div className={styles.calInfo}>
                  <span className={styles.calName}>Eliminar eventos repetidos</span>
                  <span className={styles.calUrlFull}>
                    Si dos calendarios tienen el mismo evento, se fusionan en uno solo.
                  </span>
                </div>
              </div>
            </li>
            <li className={styles.calItem}>
              <div className={styles.calItemLeft}>
                <button
                  className={`${styles.toggleBtn} ${hideLocation ? styles.toggleOn : styles.toggleOff}`}
                  onClick={() => handleToggleFormat("hideLocation")}
                  aria-label="Eliminar ubicación"
                >
                  <span className={styles.toggleThumb} />
                </button>
                <div className={styles.calInfo}>
                  <span className={styles.calName}>Eliminar ubicación de eventos</span>
                  <span className={styles.calUrlFull}>Quita la ubicación de todos los eventos del calendario</span>
                </div>
              </div>
            </li>
            <li className={`${styles.calItem} ${styles.calItemNoBorder}`}>
              <div className={styles.calItemLeft}>
                <button
                  className={`${styles.toggleBtn} ${hidePastEvents ? styles.toggleOn : styles.toggleOff}`}
                  onClick={() => handleToggleFormat("hidePastEvents")}
                  aria-label="Eliminar eventos terminados"
                >
                  <span className={styles.toggleThumb} />
                </button>
                <div className={styles.calInfo}>
                  <span className={styles.calName}>Eliminar eventos terminados</span>
                  <span className={styles.calUrlFull}>Oculta del calendario los eventos cuya fecha de fin ya expiró</span>
                </div>
              </div>
            </li>
          </ul>

          <button
            className={styles.btnAddCal}
            style={{ marginTop: "10px", borderStyle: "solid", borderWidth: "1px" }}
            onClick={() => setExceptionsOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden>
              <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" stroke="currentColor" strokeWidth="2" />
              <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Excepciones
          </button>

          <div className={styles.formatPreview}>
            <span className={styles.formatPreviewLabel}>Vista previa</span>
            <code className={styles.formatPreviewCode}>{previewTitle}</code>
          </div>
        </section>


        <section className={styles.card} aria-label="Compartir y recibir calendarios">
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrap}>
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Compartir CalSync</h2>
              <p className={styles.cardDesc}>Compartí o importá calendarios de otro usuario</p>
            </div>
          </div>
          <div className={styles.shareActions}>
            <button className={styles.btnShareAction} onClick={handleShare}>
              <svg viewBox="0 0 20 20" fill="none" width="17" height="17" aria-hidden>
                <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" fill="currentColor" />
              </svg>
              Compartir mi CalSync
            </button>
            <button className={styles.btnShareActionSecondary} onClick={handleReceiveInit}>
              <svg viewBox="0 0 20 20" fill="none" width="17" height="17" aria-hidden>
                <path d="M10 3a1 1 0 011 1v9.586l2.293-2.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 13.586V4a1 1 0 011-1zm-7 13a1 1 0 011 1h12a1 1 0 110 2H4a1 1 0 01-1-1z" fill="currentColor" />
              </svg>
              Recibir CalSync
            </button>
          </div>
          <p className={styles.cardNote}>
            Compartir copia el enlace con un mensaje listo para enviar. Para recibir, copiá el enlace de otro usuario primero.
          </p>
        </section>

        <footer className={styles.footer}>
          <p>Sesión iniciada como {cfg.displayName || cfg.email}</p>
        </footer>
      </div>

      <div
        className={`${styles.toast} ${toast ? styles.toastVisible : ""} ${toastType === "error" ? styles.toastError : ""}`}
        role="status"
        aria-live="polite"
      >
        {toastType === "error" ? (
          <svg viewBox="0 0 20 20" fill="none" width="18" height="18" aria-hidden>
            <circle cx="10" cy="10" r="9" stroke="#f87171" strokeWidth="2" />
            <path d="M7 7l6 6M13 7l-6 6" stroke="#f87171" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="none" width="18" height="18" aria-hidden>
            <circle cx="10" cy="10" r="9" stroke="#22c55e" strokeWidth="2" />
            <path d="M6 10l3 3 5-5" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {toast}
      </div>

      {editingCal && (
        <div className={styles.modalOverlay} onClick={() => setEditingCal(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label="Editar calendario">
            <h3 className={styles.modalTitle}>Editar calendario</h3>
            <div className={styles.formField}>
              <label className={styles.label} htmlFor="edit-name">Nombre</label>
              <input id="edit-name" className={styles.input} type="text" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
            </div>
            <div className={styles.formField}>
              <label className={styles.label} htmlFor="edit-url">URL (.ics)</label>
              <input id="edit-url" className={styles.input} type="url" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} />
            </div>
            <div className={styles.formActions}>
              <button className={styles.btnPrimary} onClick={handleSaveEditCal} disabled={saving}>{saving ? "Guardando..." : "Guardar cambios"}</button>
              <button className={styles.btnSecondary} onClick={() => setEditingCal(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {previewOpen && (
        <div className={styles.modalOverlay} onClick={closePreview}>
          <div className={styles.previewModal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <div className={styles.previewHeader}>
              <div className={styles.previewTitleRow}>
                <div className={styles.previewTitleWrap}>
                  <h3 className={styles.previewTitle}>{previewCalName}</h3>
                  {!previewLoading && !previewError && (
                    <p className={styles.previewSubtitle}>
                      {previewGroups.reduce((n, g) => n + g.events.length, 0)} eventos encontrados
                    </p>
                  )}
                </div>
              </div>
              <div className={styles.previewHeaderActions}>
                {!previewLoading && !previewError && previewGroups.length > 0 && (
                  <button
                    className={`${styles.btnEditMode} ${isEditMode ? styles.btnEditModeActive : ""}`}
                    onClick={isEditMode ? handleCancelEdit : () => setIsEditMode(true)}
                    title={isEditMode ? "Salir del modo edición" : "Editar eventos"}
                  >
                    <svg viewBox="0 0 20 20" fill="none" width="14" height="14" aria-hidden>
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" fill="currentColor" />
                    </svg>
                    Editar
                  </button>
                )}
                <button className={styles.closeBtn} onClick={closePreview} aria-label="Cerrar">
                  <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div className={styles.previewBody}>
              {previewLoading && <div className={styles.spinner} style={{ margin: "40px auto" }} />}
              {previewError && <p className={styles.errorMsg} style={{ padding: 20 }}>{previewError}</p>}
              {!previewLoading && !previewError && previewGroups.length === 0 && (
                <p className={styles.previewEmpty}>No hay eventos en este calendario.</p>
              )}
              {previewGroups.map((group) => (
                <div key={group.key} className={styles.dayGroup}>
                  <div className={styles.dayLabel}>{group.label}</div>
                  {group.events.map((ev) => {
                    const isDeleted = (pendingOverrides[ev.uid]?.deleted !== undefined) 
                      ? pendingOverrides[ev.uid].deleted 
                      : (config?.eventOverrides?.[ev.uid]?.deleted);

                    const title = formatEventTitle(
                      pendingOverrides[ev.uid]?.summary || ev.summary, 
                      ev.calendarName, 
                      showEmojis, 
                      showCalName, 
                      ev.calendarId, 
                      cfg.calendarExceptions
                    );

                    return (
                      <div key={ev.uid} className={`${styles.eventRow} ${isDeleted ? styles.eventRowDeleted : ""}`}>
                        {isDeleted && <span className={styles.deletedBadge}>Evento eliminado</span>}
                        <span className={styles.eventTime}>
                          {ev.allDay ? "Todo el día" : formatTime(ev.start)}
                        </span>
                        <div className={styles.previewTitleWrap}>
                          <MarqueeTitle title={title} />
                        </div>
                        {isEditMode && (
                          <div className={styles.eventActions}>
                            <button
                              className={styles.editEventBtn}
                              onClick={(e) => { e.stopPropagation(); handleOpenEditEvent(ev); }}
                              title="Editar este evento"
                              aria-label={`Editar ${ev.summary}`}
                            >
                              <svg viewBox="0 0 20 20" fill="none" width="13" height="13">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" fill="currentColor" />
                              </svg>
                            </button>
                            <button
                              className={`${styles.editEventBtn} ${isDeleted ? styles.btnRestore : ""}`}
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                handleDeleteEventOverride(ev); 
                              }}
                              title={isDeleted ? "Restaurar evento" : "Eliminar este evento"}
                              aria-label={isDeleted ? `Restaurar ${ev.summary}` : `Eliminar ${ev.summary}`}
                            >
                              {isDeleted ? (
                                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                  <path d="M3 3v5h5" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 20 20" fill="none" width="13" height="13">
                                  <path d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 112 0v6a1 1 0 11-2 0V8z" fill="currentColor" />
                                </svg>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {isEditMode && (
              <div className={styles.previewFooter}>
                <button className={styles.btnPrimary} onClick={handleSaveAllChanges} disabled={saving}>
                  {saving ? "Guardando..." : "Guardar cambios"}
                </button>
                <button className={styles.btnSecondary} onClick={handleCancelEdit}>
                  Cancelar
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {editingEvent && (
        <div className={styles.modalOverlay} onClick={() => setEditingEvent(null)}>
          <div
            className={`${styles.modal} ${styles.editEventModal}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog" aria-modal aria-label="Editar evento"
          >
            <div className={styles.editEventHeader}>
              <div>
                <h3 className={styles.modalTitle}>Editar evento</h3>
                <p className={styles.editEventSource}>📅 {editingEvent.calendarName}</p>
              </div>
              <button className={styles.closeBtn} onClick={() => setEditingEvent(null)} aria-label="Cerrar">
                <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Read-only datetime info */}
            <div className={styles.editEventMeta}>
              <span>
                🕐 {editingEvent.allDay
                  ? `${new Date(editingEvent.start).toLocaleDateString("es-AR")} · Todo el día`
                  : `${formatDatetime(editingEvent.start)} → ${formatTime(editingEvent.end)}`}
              </span>
            </div>

            <div className={styles.formField}>
              <label className={styles.label} htmlFor="ev-start">Fecha de inicio</label>
              <input
                id="ev-start"
                className={styles.input}
                type="datetime-local"
                value={editEvFields.start}
                onChange={(e) => {
                  const newStart = e.target.value;
                  setEditEvFields((f) => {
                    const dStart = new Date(newStart);
                    const dEnd = new Date(f.end);
                    let newEnd = f.end;
                    if (!isNaN(dStart.getTime()) && !isNaN(dEnd.getTime()) && dStart >= dEnd) {
                      newEnd = toDatetimeLocal(new Date(dStart.getTime() + 60 * 60 * 1000).toISOString());
                    }
                    return { ...f, start: newStart, end: newEnd };
                  });
                }}
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.label} htmlFor="ev-end">Fecha de fin</label>
              <input
                id="ev-end"
                className={styles.input}
                type="datetime-local"
                min={editEvFields.start}
                value={editEvFields.end}
                onChange={(e) => {
                  const newEnd = e.target.value;
                  setEditEvFields((f) => {
                    const dStart = new Date(f.start);
                    const dEnd = new Date(newEnd);
                    let finalEnd = newEnd;
                    if (!isNaN(dStart.getTime()) && !isNaN(dEnd.getTime()) && dEnd <= dStart) {
                      finalEnd = toDatetimeLocal(new Date(dStart.getTime() + 60 * 1000).toISOString());
                    }
                    return { ...f, end: finalEnd };
                  });
                }}
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.label} htmlFor="ev-summary">Título</label>
              <input
                id="ev-summary"
                className={styles.input}
                type="text"
                value={editEvFields.summary}
                onChange={(e) => setEditEvFields((f) => ({ ...f, summary: e.target.value }))}
                autoFocus
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.label} htmlFor="ev-location">Ubicación</label>
              <input
                id="ev-location"
                className={styles.input}
                type="text"
                placeholder="Sin ubicación"
                value={editEvFields.location}
                onChange={(e) => setEditEvFields((f) => ({ ...f, location: e.target.value }))}
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.label} htmlFor="ev-url">URL</label>
              <input
                id="ev-url"
                className={styles.input}
                type="url"
                placeholder="https://..."
                value={editEvFields.url}
                onChange={(e) => setEditEvFields((f) => ({ ...f, url: e.target.value }))}
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.label} htmlFor="ev-desc">Notas / Descripción</label>
              <textarea
                id="ev-desc"
                className={styles.textarea}
                rows={3}
                placeholder="Sin notas"
                value={editEvFields.description}
                onChange={(e) => setEditEvFields((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className={styles.formActions}>
              <button className={styles.btnPrimary} onClick={handleSaveEventOverride} disabled={saving}>
                {saving ? "Guardando..." : "Guardar"}
              </button>
              <button className={styles.btnSecondary} onClick={handleResetEventOverride} disabled={saving}>
                Restaurar original
              </button>
              <button className={styles.btnSecondary} onClick={() => handleDeleteEventOverride(editingEvent)} disabled={saving}>
                Eliminar evento
              </button>
              <button className={styles.btnSecondary} onClick={() => setEditingEvent(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {exceptionsOpen && (
        <div className={styles.modalOverlay} onClick={() => { setExceptionsOpen(false); setAddingException(false); }}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label="Gestionar excepciones">
            <div className={styles.receiveHeader}>
              <h3 className={styles.modalTitle}>Excepciones por Calendario</h3>
              <button className={styles.closeBtn} onClick={() => { setExceptionsOpen(false); setAddingException(false); }} aria-label="Cerrar">
                <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {!addingException ? (
              <>
                <p className={styles.cardDesc}>Reglas personalizadas para calendarios específicos.</p>
                <ul className={styles.calList} style={{ maxHeight: "300px", overflowY: "auto" }}>
                  {(cfg.calendarExceptions || []).length === 0 ? (
                    <li className={styles.calItem}>
                      <span className={styles.cardNote}>No hay excepciones configuradas.</span>
                    </li>
                  ) : (
                    (cfg.calendarExceptions || []).map((exc) => {
                      const cal = cfg.calendars.find(c => c.id === exc.calendarId);
                      return (
                        <li key={exc.calendarId} className={styles.calItem}>
                          <div className={styles.calInfo}>
                            <span className={styles.calName}>{cal?.name || "Calendario eliminado"}</span>
                            <span className={styles.calUrlFull}>
                              {exc.showEmojis ? "Con emojis" : "Sin emojis"} · {exc.showCalendarName ? "Con nombre" : "Sin nombre"}
                              {exc.hideLocation && " · Sin ubicación"}
                            </span>
                          </div>
                          <div className={styles.calActions}>
                            <button className={styles.iconBtn} onClick={() => handleOpenEditException(exc)} title="Editar">
                              <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" fill="currentColor" />
                              </svg>
                            </button>
                            <button className={`${styles.iconBtn} ${styles.iconBtnDanger}`} onClick={() => handleDeleteException(exc.calendarId)} title="Eliminar">
                              <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
                                <path d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 112 0v6a1 1 0 11-2 0V8z" fill="currentColor" />
                              </svg>
                            </button>
                          </div>
                        </li>
                      );
                    })
                  )}
                </ul>
                <button className={styles.btnAddCal} onClick={handleOpenAddException} style={{ marginTop: "10px" }}>
                  Agregar excepción
                </button>
              </>
            ) : (
              <div className={styles.addForm}>
                <div className={styles.formField}>
                  <label className={styles.label}>Calendario</label>
                  <select
                    className={styles.select}
                    value={newExcCalId}
                    onChange={(e) => setNewExcCalId(e.target.value)}
                    disabled={!!editingCalException}
                    style={{ width: "100%" }}
                  >
                    {cfg.calendars.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>

                <div className={styles.calList} style={{ marginTop: "8px" }}>
                  <div className={styles.calItem}>
                    <div className={styles.calItemLeft}>
                      <button
                        className={`${styles.toggleBtn} ${newExcEmojis ? styles.toggleOff : styles.toggleOn}`}
                        onClick={() => setNewExcEmojis(!newExcEmojis)}
                      >
                        <span className={styles.toggleThumb} />
                      </button>
                      <div className={styles.calInfo}>
                        <span className={styles.calName}>Eliminar emojis</span>
                        <span className={styles.calUrlFull}>Oculta emojis en este calendario</span>
                      </div>
                    </div>
                  </div>
                  <div className={styles.calItem}>
                    <div className={styles.calItemLeft}>
                      <button
                        className={`${styles.toggleBtn} ${newExcName ? styles.toggleOn : styles.toggleOff}`}
                        onClick={() => setNewExcName(!newExcName)}
                      >
                        <span className={styles.toggleThumb} />
                      </button>
                      <div className={styles.calInfo}>
                        <span className={styles.calName}>Mostrar nombre</span>
                        <span className={styles.calUrlFull}>Prefija el nombre de este calendario</span>
                      </div>
                    </div>
                  </div>
                  <div className={styles.calItem}>
                    <div className={styles.calItemLeft}>
                      <button
                        className={`${styles.toggleBtn} ${newExcHideLoc ? styles.toggleOn : styles.toggleOff}`}
                        onClick={() => setNewExcHideLoc(!newExcHideLoc)}
                      >
                        <span className={styles.toggleThumb} />
                      </button>
                      <div className={styles.calInfo}>
                        <span className={styles.calName}>Eliminar ubicación</span>
                        <span className={styles.calUrlFull}>Quita la ubicación para este calendario</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className={styles.formActions} style={{ marginTop: "12px" }}>
                  <button className={styles.btnPrimary} onClick={handleSaveException} disabled={saving || !newExcCalId}>
                    {saving ? "Guardando..." : "Guardar excepción"}
                  </button>
                  <button className={styles.btnSecondary} onClick={() => { setAddingException(false); setEditingCalException(null); }}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {receivePopup && (
        <div className={styles.modalOverlay} onClick={() => { setReceivePopup(false); setExternalData(null); }}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label="Recibir calendarios">
            <div className={styles.receiveHeader}>
              <h3 className={styles.modalTitle}>Recibir CalSync</h3>
              <button className={styles.closeBtn} onClick={() => { setReceivePopup(false); setExternalData(null); }} aria-label="Cerrar">
                <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className={styles.receiveInputRow}>
              <input
                className={styles.input}
                type="url"
                placeholder="Pegá el enlace CalSync aquí..."
                value={receiveUrl}
                onChange={(e) => setReceiveUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") lookupCalSync(receiveUrl); }}
              />
              <button
                className={styles.btnPrimary}
                onClick={() => lookupCalSync(receiveUrl)}
                disabled={externalLoading || !receiveUrl.trim()}
              >
                Buscar
              </button>
            </div>

            {externalLoading && <div className={styles.spinner} style={{ margin: "16px auto" }} />}

            {externalError && !externalLoading && (
              <p className={styles.receiveError}>{externalError}</p>
            )}

            {externalData && !externalLoading && (
              <>
                <p className={styles.receiveOwner}>
                  Calendarios de <strong>{externalData.displayName}</strong>:
                </p>
                <ul className={styles.extCalList}>
                  {externalData.calendars.map((cal) => {
                    const isSelected = selectedExtIds.has(cal.id);
                    return (
                      <li key={cal.id} className={styles.extCalItem}>
                        <button
                          className={`${styles.toggleBtn} ${isSelected ? styles.toggleOn : styles.toggleOff}`}
                          onClick={() => toggleExtId(cal.id)}
                          aria-label={isSelected ? "Deseleccionar" : "Seleccionar"}
                        >
                          <span className={styles.toggleThumb} />
                        </button>
                        <span className={styles.extCalName}>{cal.name}</span>
                      </li>
                    );
                  })}
                </ul>
                <div className={styles.formActions}>
                  <button className={styles.btnPrimary} onClick={handleSaveExternal} disabled={saving}>
                    {saving ? "Guardando..." : "Guardar cambios"}
                  </button>
                  <button className={styles.btnSecondary} onClick={() => { setReceivePopup(false); setExternalData(null); }}>
                    Cancelar
                  </button>
                </div>
              </>
            )}

            {!externalData && !externalLoading && !externalError && (
              <p className={styles.receiveHint}>Copiá el enlace CalSync de otro usuario, o pegalo arriba y presioná Buscar.</p>
            )}
          </div>
        </div>
      )}

      {/* --- Exit Confirmation Popup ------------------------------------------ */}
      {showExitConfirm && (
        <div className={styles.modalOverlay} style={{ zIndex: 1100 }}>
          <div className={styles.confirmModal}>
            <h3 className={styles.modalTitle}>¿Estás seguro que deseas salir?</h3>
            <p className={styles.cardDesc}>Se van a cancelar los cambios realizados.</p>
            <div className={styles.formActions}>
              <button 
                className={styles.btnDanger} 
                onClick={() => {
                  if (pendingAction) pendingAction();
                  setShowExitConfirm(false);
                  setPendingAction(null);
                }}
              >
                Sí, salir
              </button>
              <button className={styles.btnSecondary} onClick={() => { setShowExitConfirm(false); setPendingAction(null); }}>
                Seguir editando
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
