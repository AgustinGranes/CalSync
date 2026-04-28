"use client";

import { useAuth } from "@/lib/auth-context";

export default function GlobalLoader() {
  const { isGlobalLoading } = useAuth();

  if (!isGlobalLoading) return null;

  return (
    <div className="loadingFullscreen">
      <div className="loadingBrand">
        <svg className="loadingLogo" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
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
        <span className="loadingLogoText">CalSync</span>
        <span className="spinnerGlobal" />
      </div>
    </div>
  );
}
