"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";

const CALENDAR_URL = "/api/calendar";

type Platform = "ios" | "android" | "macos" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua) && !/Mobile/.test(ua)) return "macos";
  return "other";
}

export default function Home() {
  const [platform, setPlatform] = useState<Platform>("other");
  const [copied, setCopied] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setPlatform(detectPlatform());
    setOrigin(window.location.origin);
  }, []);

  const webcalUrl = origin
    ? origin.replace(/^https?/, "webcal") + CALENDAR_URL
    : "";
  const httpsUrl = origin ? origin + CALENDAR_URL : "";

  const handleSubscribe = () => {
    if (webcalUrl) {
      window.location.href = webcalUrl;
      setSubscribed(true);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(httpsUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement("textarea");
      ta.value = httpsUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const getInstructions = () => {
    switch (platform) {
      case "ios":
        return [
          { icon: "📱", text: 'Tocá "Suscribirse" arriba' },
          { icon: "✅", text: 'Confirmá en la app Calendario' },
          { icon: "🔄", text: "¡Listo! Se actualiza automáticamente" },
        ];
      case "macos":
        return [
          { icon: "💻", text: 'Tocá "Suscribirse" arriba' },
          { icon: "📅", text: "Se abre automáticamente en Calendario" },
          { icon: "🔄", text: "¡Listo! Se sincroniza solo" },
        ];
      case "android":
        return [
          { icon: "📋", text: 'Copiá el link con "Copiar enlace"' },
          { icon: "🌐", text: "En Google Calendar → + → Desde URL" },
          { icon: "🔄", text: "Pegá el link y suscribite" },
        ];
      default:
        return [
          { icon: "📋", text: 'Copiá el link con "Copiar enlace"' },
          { icon: "📅", text: "En tu app de calendario → Agregar calendario → Desde URL" },
          { icon: "🔄", text: "Pegá el link y confirmá" },
        ];
    }
  };

  return (
    <main className={styles.main}>
      {/* Background blobs */}
      <div className={styles.blobPurple} aria-hidden />
      <div className={styles.blobBlue} aria-hidden />
      <div className={styles.blobTeal} aria-hidden />

      <div className={styles.container}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.logoWrap}>
            <svg
              className={styles.logoIcon}
              viewBox="0 0 40 40"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden
            >
              <rect x="4" y="8" width="32" height="28" rx="5" fill="url(#g1)" />
              <rect x="4" y="8" width="32" height="10" rx="5" fill="url(#g2)" />
              <rect x="4" y="14" width="32" height="4" fill="url(#g2)" />
              <circle cx="13" cy="27" r="2.5" fill="white" fillOpacity=".9" />
              <circle cx="20" cy="27" r="2.5" fill="white" fillOpacity=".6" />
              <circle cx="27" cy="27" r="2.5" fill="white" fillOpacity=".3" />
              <line x1="12" y1="4" x2="12" y2="12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="28" y1="4" x2="28" y2="12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
              <defs>
                <linearGradient id="g1" x1="4" y1="8" x2="36" y2="36" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#7C3AED" />
                  <stop offset="1" stopColor="#2563EB" />
                </linearGradient>
                <linearGradient id="g2" x1="4" y1="8" x2="36" y2="18" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#5B21B6" />
                  <stop offset="1" stopColor="#1D4ED8" />
                </linearGradient>
              </defs>
            </svg>
            <span className={styles.logoText}>CalSync</span>
          </div>
          <p className={styles.tagline}>Tu calendario unificado</p>
        </header>

        {/* Hero */}
        <section className={styles.hero}>
          <h1 className={styles.heroTitle}>
            Todos tus calendarios,<br />
            <span className={styles.heroGradient}>en uno solo</span>
          </h1>
          <p className={styles.heroSub}>
            Sincroniza automáticamente todos tus calendarios de iCloud en una
            única suscripción WebCal. Sin apps extras, sin configuraciones
            complicadas.
          </p>
        </section>

        {/* Feature pills */}
        <div className={styles.pills} role="list" aria-label="Características">
          <div className={styles.pill} role="listitem">
            <span className={styles.pillIcon} aria-hidden>⚡</span>
            <span>Tiempo real</span>
          </div>
          <div className={styles.pill} role="listitem">
            <span className={styles.pillIcon} aria-hidden>🔄</span>
            <span>Auto-sync</span>
          </div>
          <div className={styles.pill} role="listitem">
            <span className={styles.pillIcon} aria-hidden>📅</span>
            <span>Multi-calendario</span>
          </div>
          <div className={styles.pill} role="listitem">
            <span className={styles.pillIcon} aria-hidden>🏷️</span>
            <span>Etiquetado</span>
          </div>
        </div>

        {/* Main card */}
        <div className={styles.card} aria-label="Suscripción al calendario">
          <div className={styles.cardHeader}>
            <div className={styles.cardIcon} aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="22" height="22">
                <path d="M8 2v3M16 2v3M3.5 9.09h17M21 8.5V17c0 3-1.5 5-5 5H8c-3.5 0-5-2-5-5V8.5c0-3 1.5-5 5-5h8c3.5 0 5 2 5 5z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M15.695 13.7h.009M15.695 16.7h.009M11.995 13.7h.009M11.995 16.7h.009M8.294 13.7h.009M8.294 16.7h.009" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Suscribirte al calendario</h2>
              <p className={styles.cardDesc}>
                Se actualiza automáticamente con todos tus eventos
              </p>
            </div>
          </div>

          {/* URL display */}
          <div className={styles.urlBox} aria-label="Enlace del calendario">
            <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden>
              <path d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" fill="currentColor"/>
            </svg>
            <span className={styles.urlText} aria-label="URL del calendario">
              {httpsUrl || "cargando url..."}
            </span>
          </div>

          {/* CTA buttons */}
          <div className={styles.actions}>
            <button
              id="btn-subscribe"
              className={styles.btnPrimary}
              onClick={handleSubscribe}
              disabled={!webcalUrl}
              aria-label="Suscribirse al calendario automáticamente"
            >
              <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18" aria-hidden>
                <path d="M10 3a7 7 0 100 14A7 7 0 0010 3zm-1 4a1 1 0 112 0v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2V7z" fill="currentColor"/>
              </svg>
              {subscribed ? "¡Suscripto!" : "Suscribirse"}
            </button>

            <button
              id="btn-copy-link"
              className={`${styles.btnSecondary} ${copied ? styles.copied : ""}`}
              onClick={handleCopy}
              aria-label="Copiar enlace del calendario"
            >
              {copied ? (
                <>
                  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18" aria-hidden>
                    <path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" fill="currentColor"/>
                  </svg>
                  ¡Copiado!
                </>
              ) : (
                <>
                  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18" aria-hidden>
                    <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1zm-2 0a3 3 0 015.83-1H14a3 3 0 013 3v9a3 3 0 01-3 3H6a3 3 0 01-3-3V5a3 3 0 013-3h.17A3 3 0 016 3z" fill="currentColor"/>
                  </svg>
                  Copiar enlace
                </>
              )}
            </button>
          </div>

          {subscribed && (
            <p className={styles.subscribedNote} role="status" aria-live="polite">
              Si no se abrió automáticamente, usá el botón &quot;Copiar enlace&quot; y pegalo en tu app de calendario.
            </p>
          )}
        </div>

        {/* Instructions */}
        <div className={styles.instructionsCard} aria-label="Instrucciones">
          <h3 className={styles.instructionsTitle}>
            ¿Cómo suscribirme?
          </h3>
          <ol className={styles.steps} aria-label="Pasos para suscribirse">
            {getInstructions().map((step, i) => (
              <li key={i} className={styles.step}>
                <span className={styles.stepNumber} aria-hidden>{i + 1}</span>
                <span className={styles.stepText}>{step.text}</span>
              </li>
            ))}
          </ol>

          {(platform === "android" || platform === "other") && (
            <div className={styles.googleCalTip} role="note">
              <strong>Google Calendar:</strong> Andá a{" "}
              <a
                href="https://calendar.google.com/calendar/r/settings/addbyurl"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.link}
              >
                calendar.google.com → Agregar calendario → Desde URL
              </a>{" "}
              y pegá el link.
            </div>
          )}
        </div>

        {/* Format info */}
        <div className={styles.formatCard} aria-label="Formato de eventos">
          <h3 className={styles.formatTitle}>Formato de los eventos</h3>
          <p className={styles.formatDesc}>
            Cada evento aparece con el nombre del calendario original para que
            siempre sepas de dónde viene:
          </p>
          <div className={styles.formatExamples} aria-label="Ejemplos de formato">
            <div className={styles.formatExample}>
              <span className={styles.formatBadge}>PERSONAL</span>
              <span className={styles.formatSep}>:</span>
              <span className={styles.formatEvent}>Reunión con el médico</span>
            </div>
            <div className={styles.formatExample}>
              <span className={styles.formatBadge}>TRABAJO</span>
              <span className={styles.formatSep}>:</span>
              <span className={styles.formatEvent}>Sprint planning</span>
            </div>
            <div className={styles.formatExample}>
              <span className={styles.formatBadge}>FAMILIA</span>
              <span className={styles.formatSep}>:</span>
              <span className={styles.formatEvent}>Cumpleaños de mamá</span>
            </div>
          </div>
        </div>

        <footer className={styles.footer}>
          <p>Tus calendarios se actualizan en tiempo real. Sin datos almacenados.</p>
        </footer>
      </div>
    </main>
  );
}
