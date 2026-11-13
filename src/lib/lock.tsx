// The vault lock: a per-user custom passcode (set on first run) guards access to
// the hidden app. The code is stored only as a SHA-512 hash. The lock engages
// automatically whenever the app goes to the background.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { getPasscodeHash, setPasscodeHash, wipeSettings } from './settings';
import { hashPasscode, wipeIdentity } from './crypto';
import { wipeDatabase } from './db';
import { mesh } from './mesh';

export const PASSCODE_OPERATORS = ['÷', '×', '−', '+', '%'] as const;
export type PasscodeOperator = (typeof PASSCODE_OPERATORS)[number];

export function isValidPasscode(code: string): boolean {
  return /^\d{3,8}[=÷×−+%]$/.test(code);
}

interface LockApi {
  loading: boolean;
  unlocked: boolean;
  hasCode: boolean;
  /** Saves display name + custom passcode (first run or change) and unlocks. */
  setCode: (name: string, code: string) => Promise<void>;
  /** Compares a candidate (entry + operator) against the stored hash. */
  verify: (candidate: string) => Promise<boolean>;
  lock: () => void;
  /** Panic wipe: erases all data, keys, and the passcode. */
  wipe: () => Promise<void>;
}

const LockContext = createContext<LockApi | null>(null);

export function LockProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [hasCode, setHasCode] = useState(false);

  useEffect(() => {
    void (async () => {
      const hash = await getPasscodeHash();
      setHasCode(!!hash);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') setUnlocked(false);
    });
    return () => sub.remove();
  }, []);

  const setCode = async (name: string, code: string) => {
    if (!isValidPasscode(code)) throw new Error('Invalid passcode');
    await setPasscodeHash(hashPasscode(code));
    await mesh.setName(name);
    setHasCode(true);
    setUnlocked(true);
  };

  const verify = async (candidate: string) => {
    const hash = await getPasscodeHash();
    if (!hash) return false;
    const ok = hashPasscode(candidate) === hash;
    if (ok) setUnlocked(true);
    return ok;
  };

  const wipe = async () => {
    mesh.stop();
    await wipeDatabase();
    await wipeSettings();
    await wipeIdentity();
    setHasCode(false);
    setUnlocked(false);
  };

  return (
    <LockContext.Provider value={{ loading, unlocked, hasCode, setCode, verify, lock: () => setUnlocked(false), wipe }}>
      {children}
    </LockContext.Provider>
  );
}

export function useLock(): LockApi {
  const ctx = useContext(LockContext);
  if (!ctx) throw new Error('useLock must be used inside LockProvider');
  return ctx;
}

/** Guard for every hidden screen: redirects to the calculator when locked. */
export function useRequireUnlocked(): boolean {
  const { loading, unlocked } = useLock();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !unlocked) router.replace('/');
  }, [loading, unlocked, router]);
  return !loading && unlocked;
}
