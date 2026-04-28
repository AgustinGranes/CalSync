"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { User, onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isGlobalLoading: boolean;
  setGlobalLoading: (loading: boolean) => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  isGlobalLoading: true,
  setGlobalLoading: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isGlobalLoading, setGlobalLoading] = useState(true);

  useEffect(() => {
    // Fallback: if Firebase doesn't respond in 8s, stop loading
    const timeout = setTimeout(() => {
      setLoading(false);
      setGlobalLoading(false);
    }, 8000);

    const unsub = onAuthStateChanged(
      auth,
      (firebaseUser) => {
        clearTimeout(timeout);
        setUser(firebaseUser);
        setLoading(false);
        // We don't automatically stop global loading here because 
        // the dashboard might still need to fetch its config.
        // The dashboard will call setGlobalLoading(false) when ready.
      },
      (error) => {
        clearTimeout(timeout);
        console.error("[CalSync] onAuthStateChanged error:", error);
        setLoading(false);
        setGlobalLoading(false);
      }
    );

    return () => {
      clearTimeout(timeout);
      unsub();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, isGlobalLoading, setGlobalLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
