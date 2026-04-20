"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { UserConfig, CalendarSource, ALERT_OPTIONS } from "@/lib/types";
import styles from "./page.module.css";

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const DEFAULT_CONFIG: Omit<UserConfig, "uid" | "email" | "displayName" | "photoURL" | "createdAt"> = {
  calendars: [],
  alert1Minutes: 15,
  alert2Minutes: 5,
  updatedAt: Date.now(),
};

export default function Dashboard() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [config, setConfig] = useState<UserConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");

  // New calendar form state
  const [newCalName, setNewCalName] = useState("");
  const [newCalUrl, setNewCalUrl] = useState("");
  const [addingCal, setAddingCal] = useState(false);
  const [addError, setAddError] = useState("");

  // Edit modal state
  const [editingCal, setEditingCal] = useState<CalendarSource | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [user, loading, router]);

  // Load user config from Firestore
  const loadConfig = useCallback(async () => {
    if (!user) return;
    setConfigError(null);
    try {
      const ref = doc(db, "users", user.uid);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        setConfig(snap.data() as UserConfig);
      } else {
        // Create default config
        const newConfig: UserConfig = {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
          ...DEFAULT_CONFIG,
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

  // Save config to Firestore
  const saveConfig = async (updated: UserConfig) => {
    if (!user) return;
    setSaving(true);
    try {
      const ref = doc(db, "users", user.uid);
      const toSave = { ...updated, updatedAt: Date.now() };
      await setDoc(ref, toSave, { merge: true });
      setConfig(toSave);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Save error:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    router.push("/");
  };

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

  // ─── Calendar Management ──────────────────────────────────────────────────

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
    const newCal: CalendarSource = {
      id: generateId(),
      name,
      url: normalized,
      enabled: true,
    };
    const updated = {
      ...config,
      calendars: [...config.calendars, newCal],
    };
    await saveConfig(updated);
    setNewCalName("");
    setNewCalUrl("");
    setAddingCal(false);
  };

  const handleToggleCalendar = async (id: string) => {
    if (!config) return;
    const updated = {
      ...config,
      calendars: config.calendars.map((c) =>
        c.id === id ? { ...c, enabled: !c.enabled } : c
      ),
    };
    await saveConfig(updated);
  };

  const handleDeleteCalendar = async (id: string) => {
    if (!config) return;
    const updated = {
      ...config,
      calendars: config.calendars.filter((c) => c.id !== id),
    };
    await saveConfig(updated);
  };

  const handleOpenEdit = (cal: CalendarSource) => {
    setEditingCal(cal);
    setEditName(cal.name);
    setEditUrl(cal.url);
  };

  const handleSaveEdit = async () => {
    if (!config || !editingCal) return;
    const updated = {
      ...config,
      calendars: config.calendars.map((c) =>
        c.id === editingCal.id
          ? { ...c, name: editName.trim(), url: editUrl.trim() }
          : c
      ),
    };
    await saveConfig(updated);
    setEditingCal(null);
  };

  // ─── Alert Settings ───────────────────────────────────────────────────────

  const handleAlertChange = async (
    field: "alert1Minutes" | "alert2Minutes",
    value: number
  ) => {
    if (!config) return;
    const updated = { ...config, [field]: value };
    setConfig(updated); // Optimistic update
    await saveConfig(updated);
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading || (!config && !configError)) {
    return (
      <main className={styles.main}>
        <div className={styles.blobPurple} aria-hidden />
        <div className={styles.blobBlue} aria-hidden />
        <div className={styles.loadingCenter}>
          <div className={styles.spinner} />
        </div>
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
            <button className={styles.btnRetry} onClick={() => loadConfig()}>
              Reintentar
            </button>
            <button className={styles.btnRetrySecondary} onClick={handleLogout}>
              Cerrar sesión
            </button>
          </div>
        </div>
      </main>
    );
  }

  // At this point config is guaranteed non-null
  const safeConfig = config!;

  return (
    <main className={styles.main}>
      <div className={styles.blobPurple} aria-hidden />
      <div className={styles.blobBlue} aria-hidden />
      <div className={styles.blobTeal} aria-hidden />

      <div className={styles.container}>
        {/* ─── Top Bar ─────────────────────────────────────────────────── */}
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
            {safeConfig.photoURL && (
              <img
                src={safeConfig.photoURL}
                alt={safeConfig.displayName || "Usuario"}
                className={styles.avatar}
              />
            )}
            <button
              id="btn-logout"
              className={styles.btnLogout}
              onClick={handleLogout}
              aria-label="Cerrar sesión"
            >
              Salir
            </button>
          </div>
        </header>

        {/* ─── Personal Link Card ───────────────────────────────────────── */}
        <section className={styles.card} aria-label="Tu enlace personal">
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrap}>
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
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
            <button
              id="btn-subscribe"
              className={styles.btnPrimary}
              onClick={handleSubscribe}
              disabled={!webcalUrl}
            >
              <svg viewBox="0 0 20 20" fill="none" width="17" height="17" aria-hidden>
                <path d="M10 3a7 7 0 100 14A7 7 0 0010 3zm-1 4a1 1 0 112 0v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2V7z" fill="currentColor" />
              </svg>
              Suscribirse
            </button>
            <button
              id="btn-copy"
              className={`${styles.btnSecondary} ${copied ? styles.btnSuccess : ""}`}
              onClick={handleCopy}
            >
              {copied ? "¡Copiado! ✓" : "Copiar enlace"}
            </button>
          </div>

          <p className={styles.cardNote}>
            Pegá este enlace en Apple Calendario, Google Calendar o cualquier app compatible con WebCal.
          </p>
        </section>

        {/* ─── Calendars Card ───────────────────────────────────────────── */}
        <section className={styles.card} aria-label="Gestión de calendarios">
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrap}>
              <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
                <path d="M8 2v3M16 2v3M3.5 9.09h17M21 8.5V17c0 3-1.5 5-5 5H8c-3.5 0-5-2-5-5V8.5c0-3 1.5-5 5-5h8c3.5 0 5 2 5 5z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Mis calendarios</h2>
              <p className={styles.cardDesc}>
                {safeConfig.calendars.length === 0
                  ? "No tenés calendarios configurados"
                  : `${safeConfig.calendars.filter((c) => c.enabled).length} de ${safeConfig.calendars.length} activos`}
              </p>
            </div>
          </div>

          {/* Calendar list */}
          {safeConfig.calendars.length > 0 && (
            <ul className={styles.calList} aria-label="Lista de calendarios">
              {safeConfig.calendars.map((cal) => (
                <li key={cal.id} className={`${styles.calItem} ${!cal.enabled ? styles.calItemDisabled : ""}`}>
                  <div className={styles.calItemLeft}>
                    <button
                      className={`${styles.toggleBtn} ${cal.enabled ? styles.toggleOn : styles.toggleOff}`}
                      onClick={() => handleToggleCalendar(cal.id)}
                      aria-label={cal.enabled ? "Desactivar calendario" : "Activar calendario"}
                      title={cal.enabled ? "Activo — click para desactivar" : "Inactivo — click para activar"}
                    >
                      <span className={styles.toggleThumb} />
                    </button>
                    <div className={styles.calInfo}>
                      <span className={styles.calName}>{cal.name}</span>
                      <span className={styles.calUrl}>{cal.url.replace(/^https?:\/\//, "")}</span>
                    </div>
                  </div>
                  <div className={styles.calActions}>
                    <button
                      className={styles.iconBtn}
                      onClick={() => handleOpenEdit(cal)}
                      aria-label={`Editar ${cal.name}`}
                      title="Editar"
                    >
                      <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
                        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" fill="currentColor" />
                      </svg>
                    </button>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() => handleDeleteCalendar(cal.id)}
                      aria-label={`Eliminar ${cal.name}`}
                      title="Eliminar"
                    >
                      <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
                        <path d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 112 0v6a1 1 0 11-2 0V8z" fill="currentColor" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Add calendar form */}
          {addingCal ? (
            <div className={styles.addForm}>
              <div className={styles.formField}>
                <label className={styles.label} htmlFor="cal-name">Nombre del calendario</label>
                <input
                  id="cal-name"
                  className={styles.input}
                  type="text"
                  placeholder="ej: Personal, Trabajo, Formula 1"
                  value={newCalName}
                  onChange={(e) => setNewCalName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className={styles.formField}>
                <label className={styles.label} htmlFor="cal-url">URL del calendario (.ics)</label>
                <input
                  id="cal-url"
                  className={styles.input}
                  type="url"
                  placeholder="https://p01-caldav.icloud.com/... o webcal://..."
                  value={newCalUrl}
                  onChange={(e) => setNewCalUrl(e.target.value)}
                />
              </div>
              {addError && <p className={styles.error}>{addError}</p>}
              <div className={styles.formActions}>
                <button
                  id="btn-confirm-add"
                  className={styles.btnPrimary}
                  onClick={handleAddCalendar}
                  disabled={saving}
                >
                  {saving ? "Guardando..." : "Agregar calendario"}
                </button>
                <button
                  className={styles.btnSecondary}
                  onClick={() => { setAddingCal(false); setAddError(""); }}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button
              id="btn-add-calendar"
              className={styles.btnAddCal}
              onClick={() => setAddingCal(true)}
            >
              <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden>
                <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" fill="currentColor" />
              </svg>
              Agregar calendario
            </button>
          )}
        </section>

        {/* ─── Alerts Card ───────────────────────────────────────────────── */}
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
              <span className={styles.alertBadge}>1ª</span>
              Primera alerta
            </label>
            <select
              id="alert1"
              className={styles.select}
              value={safeConfig.alert1Minutes}
              onChange={(e) => handleAlertChange("alert1Minutes", Number(e.target.value))}
            >
              {ALERT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.alertRow}>
            <label className={styles.alertLabel} htmlFor="alert2">
              <span className={styles.alertBadge}>2ª</span>
              Segunda alerta
            </label>
            <select
              id="alert2"
              className={styles.select}
              value={safeConfig.alert2Minutes}
              onChange={(e) => handleAlertChange("alert2Minutes", Number(e.target.value))}
            >
              {ALERT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {(saving || saved) && (
            <p className={`${styles.saveStatus} ${saved ? styles.saveOk : ""}`} role="status">
              {saving ? "Guardando..." : "✓ Guardado"}
            </p>
          )}
        </section>

        <footer className={styles.footer}>
          <p>Sesión iniciada como {safeConfig.displayName || safeConfig.email}</p>
        </footer>
      </div>

      {/* ─── Edit Modal ────────────────────────────────────────────────── */}
      {editingCal && (
        <div className={styles.modalOverlay} onClick={() => setEditingCal(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label="Editar calendario">
            <h3 className={styles.modalTitle}>Editar calendario</h3>

            <div className={styles.formField}>
              <label className={styles.label} htmlFor="edit-name">Nombre</label>
              <input
                id="edit-name"
                className={styles.input}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.label} htmlFor="edit-url">URL (.ics)</label>
              <input
                id="edit-url"
                className={styles.input}
                type="url"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
              />
            </div>

            <div className={styles.formActions}>
              <button className={styles.btnPrimary} onClick={handleSaveEdit} disabled={saving}>
                {saving ? "Guardando..." : "Guardar cambios"}
              </button>
              <button className={styles.btnSecondary} onClick={() => setEditingCal(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
