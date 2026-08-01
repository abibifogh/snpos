import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { account, db, DB_ID, Query, applyThemeSettings } from './lib';
import type { Models } from 'appwrite';
import type { Settings, StaffProfile } from '@snpos/core';

interface SessionValue {
  user: Models.User<Models.Preferences> | null;
  profile: StaffProfile | null;
  settings: Settings | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const Ctx = createContext<SessionValue>({} as SessionValue);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSettings = useCallback(async () => {
    const doc = (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings;
    setSettings(doc);
    applyThemeSettings(doc);
    return doc;
  }, []);

  const loadProfile = useCallback(async (userId: string) => {
    const res = await db.listDocuments(DB_ID, 'staff_profiles', [Query.equal('user_id', userId), Query.limit(1)]);
    setProfile((res.documents[0] as unknown as StaffProfile) ?? null);
  }, []);

  // Settings are readable without a session so the login screen can already be
  // branded; the profile needs one.
  useEffect(() => {
    (async () => {
      try {
        await loadSettings();
      } catch {
        /* not provisioned yet — the login screen explains it */
      }
      try {
        const me = await account.get();
        setUser(me);
        await loadProfile(me.$id);
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadSettings, loadProfile]);

  const signIn = async (email: string, password: string) => {
    await account.createEmailPasswordSession(email, password);
    const me = await account.get();
    setUser(me);
    await loadProfile(me.$id);
    await loadSettings();
  };

  const signOut = async () => {
    try {
      await account.deleteSession('current');
    } finally {
      setUser(null);
      setProfile(null);
    }
  };

  return (
    <Ctx.Provider
      value={{
        user,
        profile,
        settings,
        loading,
        signIn,
        signOut,
        refreshSettings: async () => {
          await loadSettings();
        },
        refreshUser: async () => {
          setUser(await account.get());
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
