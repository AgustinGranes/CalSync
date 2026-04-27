"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail,
} from "firebase/auth";
import { doc, setDoc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import styles from "./page.module.css";

type AuthMode = "login" | "register";

async function ensureUserDoc(uid: string, email: string | null, displayName: string | null, photoURL: string | null) {
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) {
    await setDoc(userRef, {
      uid,
      email,
      displayName,
      photoURL,
      calendars: [],
      alert1Minutes: 15,
      alert2Minutes: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [authError, setAuthError] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(true);

  useEffect(() => {
    if (!loading && user) router.push("/dashboard");
  }, [user, loading, router]);

  // Handle redirect result from Google Sign-In
  useEffect(() => {
    getRedirectResult(auth)
      .then(async (result) => {
        if (result?.user) {
          const { uid, email: e, displayName, photoURL } = result.user;
          await ensureUserDoc(uid, e, displayName, photoURL);
          router.push("/dashboard");
        } else {
          setRedirecting(false);
        }
      })
      .catch((err: unknown) => {
        const code = (err as { code?: string })?.code ?? "";
        if (code && code !== "auth/no-current-user") {
          setAuthError("Error al iniciar sesión con Google. Intentá con email.");
        }
        setRedirecting(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearError = () => { setAuthError(""); setAuthMsg(""); };

  // ─── Google ───────────────────────────────────────────────────────────────
  const handleGoogleLogin = async () => {
    setAuthError("");
    setAuthLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithRedirect(auth, provider);
      // Page will redirect — no further code runs here
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      setAuthError(code ? `Error: ${code}` : "Error al iniciar sesión con Google.");
      setAuthLoading(false);
    }
  };

  // ─── Email / Password ─────────────────────────────────────────────────────
  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);

    try {
      if (mode === "login") {
        const result = await signInWithEmailAndPassword(auth, email, password);
        const { uid, email: userEmail, displayName, photoURL } = result.user;
        await ensureUserDoc(uid, userEmail, displayName, photoURL);
      } else {
        if (!name.trim()) { setAuthError("Ingresá tu nombre."); setAuthLoading(false); return; }
        if (password.length < 6) { setAuthError("La contraseña debe tener al menos 6 caracteres."); setAuthLoading(false); return; }
        const result = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(result.user, { displayName: name.trim() });
        await sendEmailVerification(result.user);
        await ensureUserDoc(result.user.uid, email, name.trim(), null);
      }
      router.push("/dashboard");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      const messages: Record<string, string> = {
        "auth/user-not-found":       "No existe una cuenta con ese email.",
        "auth/wrong-password":       "Contraseña incorrecta.",
        "auth/email-already-in-use": "Ya existe una cuenta con ese email. Iniciá sesión.",
        "auth/invalid-email":        "El email no es válido.",
        "auth/weak-password":        "Contraseña demasiado débil (mínimo 6 caracteres).",
        "auth/invalid-credential":   "Email o contraseña incorrectos.",
        "auth/too-many-requests":    "Demasiados intentos fallidos. Esperá un momento.",
      };
      setAuthError(messages[code] ?? `Error: ${code || "desconocido"}`);
    } finally {
      setAuthLoading(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!email.trim()) {
      setAuthError("Ingresá tu email para recuperar la contraseña.");
      return;
    }
    setAuthError("");
    setAuthMsg("");
    setAuthLoading(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setAuthMsg("Se ha enviado un enlace de recuperación. REVISÁ TU CARPETA DE SPAM.");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "auth/user-not-found" || code === "auth/invalid-email") {
        setAuthError("El email ingresado no es válido o no está registrado.");
      } else {
        setAuthError("Error al enviar el correo de recuperación.");
      }
    } finally {
      setAuthLoading(false);
    }
  };

  if (loading || user || redirecting) {
    // Still determining auth state, OR user is logged in and redirect is pending,
    // OR processing Google redirect — show simple spinner.
    return (
      <div className={styles.loadingFullscreen}>
        <div className={styles.blobPurple} aria-hidden />
        <div className={styles.blobBlue} aria-hidden />
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

  return (
    <main className={styles.main}>
      <div className={styles.blobPurple} aria-hidden />
      <div className={styles.blobBlue} aria-hidden />
      <div className={styles.blobTeal} aria-hidden />

      <div className={styles.container}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.logoWrap}>
            <svg className={styles.logoIcon} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
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
                  <stop stopColor="#7C3AED" /><stop offset="1" stopColor="#2563EB" />
                </linearGradient>
                <linearGradient id="g2" x1="4" y1="8" x2="36" y2="18" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#5B21B6" /><stop offset="1" stopColor="#1D4ED8" />
                </linearGradient>
              </defs>
            </svg>
            <span className={styles.logoText}>CalSync</span>
          </div>
        </header>

        {/* Hero */}
        <section className={styles.hero}>
          <h1 className={styles.heroTitle}>
            Todos tus calendarios,<br />
            <span className={styles.heroGradient}>en uno solo</span>
          </h1>
          <p className={styles.heroSub}>
            Unificá todos tus calendarios en una suscripción WebCal personalizada.
            Con alertas configurables y tu propio link único.
          </p>
        </section>

        {/* Feature pills */}
        <div className={styles.pills} role="list">
          {[
            { icon: "⚡", label: "Tiempo real" },
            { icon: "🔔", label: "Alertas custom" },
            { icon: "🔗", label: "Link personal" },
            { icon: "🏷️", label: "Etiquetado" },
          ].map((p) => (
            <div key={p.label} className={styles.pill} role="listitem">
              <span className={styles.pillIcon} aria-hidden>{p.icon}</span>
              <span>{p.label}</span>
            </div>
          ))}
        </div>

        {/* Auth Card */}
        <div className={styles.loginCard}>
          {/* Mode tabs */}
          <div className={styles.tabs} role="tablist">
            <button
              role="tab"
              aria-selected={mode === "login"}
              className={`${styles.tab} ${mode === "login" ? styles.tabActive : ""}`}
              onClick={() => { setMode("login"); clearError(); }}
            >
              Iniciar sesión
            </button>
            <button
              role="tab"
              aria-selected={mode === "register"}
              className={`${styles.tab} ${mode === "register" ? styles.tabActive : ""}`}
              onClick={() => { setMode("register"); clearError(); }}
            >
              Crear cuenta
            </button>
          </div>

          {/* Google button */}
          <button
            id="btn-google-login"
            className={styles.btnGoogle}
            onClick={handleGoogleLogin}
            disabled={authLoading}
            aria-label="Continuar con Google"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continuar con Google
          </button>

          {/* Divider */}
          <div className={styles.divider}>
            <span className={styles.dividerLine} />
            <span className={styles.dividerText}>o</span>
            <span className={styles.dividerLine} />
          </div>

          {/* Email form */}
          <form onSubmit={handleEmailAuth} className={styles.form} noValidate>
            {mode === "register" && (
              <div className={styles.field}>
                <label htmlFor="auth-name" className={styles.fieldLabel}>Nombre</label>
                <input
                  id="auth-name"
                  type="text"
                  className={styles.fieldInput}
                  placeholder="Tu nombre"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                />
              </div>
            )}
            <div className={styles.field}>
              <label htmlFor="auth-email" className={styles.fieldLabel}>Email</label>
              <input
                id="auth-email"
                type="email"
                className={styles.fieldInput}
                placeholder="tu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="auth-password" className={styles.fieldLabel}>Contraseña</label>
              <input
                id="auth-password"
                type="password"
                className={styles.fieldInput}
                placeholder={mode === "register" ? "Mínimo 6 caracteres" : "Tu contraseña"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
              />
            </div>

            {mode === "login" && (
              <div style={{ textAlign: "right", marginTop: "-10px", marginBottom: "15px" }}>
                <button
                  type="button"
                  className={styles.tab}
                  style={{ fontSize: "0.85rem", padding: 0 }}
                  onClick={handlePasswordReset}
                  disabled={authLoading}
                >
                  ¿Olvidaste tu contraseña?
                </button>
              </div>
            )}

            {authError && (
              <p className={styles.authError} role="alert">{authError}</p>
            )}
            {authMsg && (
              <p className={styles.authError} style={{ color: "#10b981", background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.2)" }} role="status">{authMsg}</p>
            )}

            <button
              id="btn-email-auth"
              type="submit"
              className={styles.btnSubmit}
              disabled={authLoading}
            >
              {authLoading
                ? "Cargando..."
                : mode === "login"
                ? "Iniciar sesión"
                : "Crear cuenta"}
            </button>
          </form>
        </div>

        <footer className={styles.footer}>
          <p>Tus calendarios se actualizan en tiempo real. Configuración guardada en la nube.</p>
        </footer>
      </div>
    </main>
  );
}
