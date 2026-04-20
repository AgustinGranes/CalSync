"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { UserConfig, CalendarSource, ALERT_OPTIONS } from "@/lib/types";
import styles from "./page.module.css";

// ─── Helper types ─────────────────────────────────────────────────────────────

interface RawEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
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

// ─── Helper functions ─────────────────────────────────────────────────────────

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
  showCalName: boolean
): string {
  const title = showEmojis ? rawSummary : stripEmojisClient(rawSummary);
  if (showCalName) {
    const prefix = (showEmojis ? calName : stripEmojisClient(calName)).toUpperCase().trim();
    return `${prefix}: ${title}`;
  }
  return title;
}

function groupEventsByDay(events: RawEvent[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const ev of events) {
    const d = new Date(ev.start);
    const key = d.toISOString().slice(0, 10);
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: d.toLocaleDateString("es-AR", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
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

const DEFAULT_CONFIG_FIELDS = {
  calendars: [] as CalendarSource[],
  alert1Minutes: 15,
  alert2Minutes: 5,
  showEmojis: false,
  showCalendarName: true,
  updatedAt: Date.now(),
};

// ─── Component ────────────────────────────────────────────────────────────────

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
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // Calendar form
  const [newCalName, setNewCalName] = useState("");
  const [newCalUrl, setNewCalUrl] = useState("");
  const [addingCal, setAddingCal] = useState(false);
  const [addError, setAddError] = useState("");

  // Edit modal
  const [editingCal, setEditingCal] = useState<CalendarSource | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");

  // Collapsible calendar section
  const [calsExpanded, setCalsExpanded] = useState(false);

  // Event preview modal
  const [previewCal, setPreviewCal] = useState<CalendarSource | null>(null);
  const [previewGroups, setPreviewGroups] = useState<DayGroup[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  // Share/Receive
  const [receivePopup, setReceivePopup] = useState(false);
  const [externalData, setExternalData] = useState<ExternalCalData | null>(null);
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState("");
  const [selectedExtIds, setSelectedExtIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (!loading && !user) router.push("/");
  }, [user, loading, router]);

  // ─── Load config ────────────────────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    if (!user) return;
    setConfigError(null);
    try {
      const ref = doc(db, "users", user.uid);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const data = snap.data() as UserConfig;
        // Merge defaults for new fields
        setConfig({
          ...DEFAULT_CONFIG_FIELDS,
          ...data,
        });
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

  useEffect(() => {
    if (user) loadConfig();
  }, [user, loadConfig]);

  // ─── Save config ────────────────────────────────────────────────────────────

  const saveConfig = async (updated: UserConfig, toastMsg = "Guardado") => {
    if (!user) return;
    setSaving(true);
    try {
      const ref = doc(db, "users", user.uid);
      const toSave = { ...updated, updatedAt: Date.now() };
      await setDoc(ref, toSave, { merge: true });
      setConfig(toSave);
      showToast(`✓ ${toastMsg}`);
    } catch (err) {
      console.error("Save error:", err);
      showToast("✗ Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    router.push("/");
  };

  // ─── Derived URLs ────────────────────────────────────────────────────────────

  const webcalUrl = user && origin
    ? origin.replace(/^https?/, "webcal") + `/api/calendar/${user.uid}`
    : "";
  const httpsUrl = user && origin
    ? `${origin}/api/calendar/${user.uid}`
    : "";

  const handleCopy = async () => {
    if (!httpsUrl) return;
    await navigator.clipboard.writeText(httpsUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleSubscribe = () => {
    if (webcalUrl) window.location.href = webcalUrl;
  };

  // ─── Calendar management ─────────────────────────────────────────────────────

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

  const handleOpenEdit = (cal: CalendarSource) => {
    setEditingCal(cal); setEditName(cal.name); setEditUrl(cal.url);
  };

  const handleSaveEdit = async () => {
    if (!config || !editingCal) return;
    await saveConfig({
      ...config,
      calendars: config.calendars.map((c) =>
        c.id === editingCal.id ? { ...c, name: editName.trim(), url: editUrl.trim() } : c
      ),
    }, "Cambios guardados");
    setEditingCal(null);
  };

  // ─── Alert settings ──────────────────────────────────────────────────────────

  const handleAlertChange = async (field: "alert1Minutes" | "alert2Minutes", value: number) => {
    if (!config) return;
    const updated = { ...config, [field]: value };
    setConfig(updated);
    await saveConfig(updated, "Alerta actualizada");
  };

  // ─── Format settings ─────────────────────────────────────────────────────────

  const handleToggleFormat = async (field: "showEmojis" | "showCalendarName") => {
    if (!config) return;
    const updated = { ...config, [field]: !config[field] };
    setConfig(updated);
    await saveConfig(updated, "Formato actualizado");
  };

  // ─── Event preview ───────────────────────────────────────────────────────────

  const handleOpenPreview = async (cal: CalendarSource) => {
    setPreviewCal(cal);
    setPreviewGroups([]);
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/preview?uid=${user?.uid}&calId=${cal.id}`);
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

  // ─── Share / Receive ──────────────────────────────────────────────────────────

  const handleShare = async () => {
    if (!user || !origin) return;
    const link = `${origin}/api/calendar/${user.uid}`;
    const msg = `¡Seleccioná los calendarios que quieras de mi CalSync!\n${link}`;
    await navigator.clipboard.writeText(msg);
    showToast("✓ Enlace copiado al portapapeles");
  };

  const handleReceiveInit = async () => {
    setExternalData(null);
    setExternalError("");
    setSelectedExtIds(new Set());
    setReceivePopup(true);
    setExternalLoading(true);
    try {
      const text = await navigator.clipboard.readText();
      const match = text.match(/\/api\/calendar\/([a-zA-Z0-9_-]+)/);
      if (!match) {
        setExternalError("El portapapeles no contiene un enlace CalSync válido.");
        setExternalLoading(false);
        return;
      }
      const uid = match[1];
      if (uid === user?.uid) {
        setExternalError("No podés importar tu propio CalSync.");
        setExternalLoading(false);
        return;
      }
      const res = await fetch(`/api/user/${uid}`);
      if (!res.ok) {
        setExternalError("No se encontró ese CalSync.");
        setExternalLoading(false);
        return;
      }
      const data: ExternalCalData = await res.json();
      if (!data.calendars || data.calendars.length === 0) {
        setExternalError("Este CalSync está vacío o no tiene calendarios activos.");
        setExternalLoading(false);
        return;
      }
      // Pre-select calendars the user already has (same URL)
      const existingUrls = new Set((config?.calendars || []).map((c) => c.url));
      const pre = new Set<string>();
      for (const cal of data.calendars) {
        if (existingUrls.has(cal.url)) pre.add(cal.id);
      }
      setExternalData(data);
      setSelectedExtIds(pre);
    } catch {
      setExternalError("No se pudo leer el portapapeles. Pegá el enlace manualmente o intentá de nuevo.");
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
        `${toAdd.length} calendario${toAdd.length !== 1 ? "s" : ""} importado${toAdd.length !== 1 ? "s" : ""}`
      );
    } else {
      showToast("Sin cambios nuevos");
    }
    setReceivePopup(false);
    setExternalData(null);
  };

  // ─── Loading / Error states ───────────────────────────────────────────────────

  if (loading || (!config && !configError)) {
    return (
      <main className={styles.main}>
        <div className={styles.blobPurple} aria-hidden />
        <div className={styles.blobBlue} aria-hidden />
        <div className={styles.loadingCenter}><div className={styles.spinner} /></div>
      </main>
    );
  }

  if (configError) {
    return (
      <main className={styles.main}>
        <div className={styles.blobPurple} aria-hidden />
        <div className={styles.blobBlue} aria-hidden />
        <div className={styles.loadingCenter}>
          <div className={styles.errorBox}>
            <p className={styles.errorTitle}>Error de conexión</p>
            <p className={styles.errorMsg}>{configError}</p>
            <button className={styles.btnRetry} onClick={() => loadConfig()}>Reintentar</button>
            <button className={styles.btnRetrySecondary} onClick={handleLogout}>Cerrar sesión</button>
          </div>
        </div>
      </main>
    );
  }

  const cfg = config!;
  const showEmojis = cfg.showEmojis ?? false;
  const showCalName = cfg.showCalendarName ?? true;
  const previewTitle = formatEventTitle("🏎️ Gran Premio de Melbourne", "Formula 1", showEmojis, showCalName);

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <main className={styles.main}>
      <div className={styles.blobPurple} aria-hidden />
      <div className={styles.blobBlue} aria-hidden />
      <div className={styles.blobTeal} aria-hidden />

      <div className={styles.container}>

        {/* ── Top Bar ──────────────────────────────────────────────────────── */}
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

        {/* ── Personal Link Card ───────────────────────────────────────────── */}
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

        {/* ── Calendars Card (collapsible) ─────────────────────────────────── */}
        <section className={styles.card} aria-label="Gestión de calendarios">
          {/* Header — always visible, acts as toggle */}
          <button
            className={styles.collapsibleHeader}
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

          {/* Body — collapsible */}
          <div className={`${styles.collapsibleBody} ${calsExpanded ? styles.collapsibleBodyOpen : ""}`}>
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
                      <button className={styles.iconBtn} onClick={() => handleOpenEdit(cal)} aria-label={`Editar ${cal.name}`} title="Editar">
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
        </section>

        {/* ── Alerts Card ──────────────────────────────────────────────────── */}
        <section className={styles.card} aria-label="Configuración de alertas">
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrap}>
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Alertas de eventos</h2>
              <p className={styles.cardDesc}>Se agregan a todos tus eventos automáticamente</p>
            </div>
          </div>
          <div className={styles.alertRow}>
            <label className={styles.alertLabel} htmlFor="alert1">
              <span className={styles.alertBadge}>1ª</span>Primera alerta
            </label>
            <select id="alert1" className={styles.select} value={cfg.alert1Minutes} onChange={(e) => handleAlertChange("alert1Minutes", Number(e.target.value))}>
              {ALERT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
          <div className={styles.alertRow}>
            <label className={styles.alertLabel} htmlFor="alert2">
              <span className={styles.alertBadge}>2ª</span>Segunda alerta
            </label>
            <select id="alert2" className={styles.select} value={cfg.alert2Minutes} onChange={(e) => handleAlertChange("alert2Minutes", Number(e.target.value))}>
              {ALERT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
        </section>

        {/* ── Format Settings Card ─────────────────────────────────────────── */}
        <section className={styles.card} aria-label="Formato de eventos">
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrap}>
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Formato de eventos</h2>
              <p className={styles.cardDesc}>Cómo aparecen los títulos en tu calendario</p>
            </div>
          </div>

          <div className={styles.calItem}>
            <div className={styles.calItemLeft}>
              <button
                className={`${styles.toggleBtn} ${showEmojis ? styles.toggleOn : styles.toggleOff}`}
                onClick={() => handleToggleFormat("showEmojis")}
                aria-label="Activar emojis en títulos"
              >
                <span className={styles.toggleThumb} />
              </button>
              <div className={styles.calInfo}>
                <span className={styles.calName}>Mostrar emojis en títulos</span>
                <span className={styles.calUrl}>Mantiene los emojis originales de cada evento</span>
              </div>
            </div>
          </div>

          <div className={styles.calItem} style={{ borderBottom: "none" }}>
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
                <span className={styles.calUrl}>Prefija cada evento con el nombre del calendario</span>
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className={styles.formatPreview}>
            <span className={styles.formatPreviewLabel}>Vista previa</span>
            <code className={styles.formatPreviewCode}>{previewTitle}</code>
          </div>
        </section>

        {/* ── Share / Receive Card ─────────────────────────────────────────── */}
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

      {/* ── Toast notification ───────────────────────────────────────────── */}
      <div className={`${styles.toast} ${toast ? styles.toastVisible : ""}`} role="status" aria-live="polite">
        <svg viewBox="0 0 20 20" fill="none" width="18" height="18" aria-hidden>
          <circle cx="10" cy="10" r="9" stroke="#22c55e" strokeWidth="2" />
          <path d="M6 10l3 3 5-5" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {toast}
      </div>

      {/* ── Edit Calendar Modal ──────────────────────────────────────────── */}
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
              <button className={styles.btnPrimary} onClick={handleSaveEdit} disabled={saving}>{saving ? "Guardando..." : "Guardar cambios"}</button>
              <button className={styles.btnSecondary} onClick={() => setEditingCal(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Event Preview Modal ──────────────────────────────────────────── */}
      {previewCal && (
        <div className={styles.modalOverlay} onClick={() => { setPreviewCal(null); setPreviewGroups([]); }}>
          <div className={styles.previewModal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <div className={styles.previewHeader}>
              <div>
                <h3 className={styles.previewTitle}>{previewCal.name}</h3>
                {!previewLoading && !previewError && (
                  <p className={styles.previewSubtitle}>
                    {previewGroups.reduce((n, g) => n + g.events.length, 0)} eventos encontrados
                  </p>
                )}
              </div>
              <button className={styles.closeBtn} onClick={() => { setPreviewCal(null); setPreviewGroups([]); }} aria-label="Cerrar">
                <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
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
                  {group.events.map((ev, i) => (
                    <div key={i} className={styles.eventRow}>
                      <span className={styles.eventTime}>
                        {ev.allDay ? "Todo el día" : formatTime(ev.start)}
                      </span>
                      <span className={styles.eventTitle}>
                        {formatEventTitle(ev.summary, previewCal.name, showEmojis, showCalName)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Receive CalSync Popup ────────────────────────────────────────── */}
      {receivePopup && (
        <div className={styles.modalOverlay} onClick={() => { setReceivePopup(false); setExternalData(null); }}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label="Recibir calendarios">
            <h3 className={styles.modalTitle}>Recibir CalSync</h3>

            {externalLoading && <div className={styles.spinner} style={{ margin: "20px auto" }} />}

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
                    {saving ? "Guardando..." : `Guardar ${selectedExtIds.size} seleccionado${selectedExtIds.size !== 1 ? "s" : ""}`}
                  </button>
                  <button className={styles.btnSecondary} onClick={() => { setReceivePopup(false); setExternalData(null); }}>
                    Cancelar
                  </button>
                </div>
              </>
            )}

            {!externalData && !externalLoading && !externalError && (
              <p className={styles.receiveHint}>Copiá el enlace CalSync de otro usuario y presioná Recibir.</p>
            )}

            {!externalLoading && (
              <button className={styles.closeBtn} style={{ position: "absolute", top: 16, right: 16 }}
                onClick={() => { setReceivePopup(false); setExternalData(null); }} aria-label="Cerrar">
                <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
