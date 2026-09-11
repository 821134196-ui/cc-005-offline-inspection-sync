import { useEffect, useState, useCallback } from 'react';
import { store } from './store.js';

// Subscribes React to the SyncStore event bus. `tick` bumps after every change
// event so callers re-read IndexedDB. Online/offline flips re-render too.
export function useStore() {
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [user, setUser] = useState(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let alive = true;
    store.currentUser().then((u) => alive && setUser(u));
    const onChange = (e) => {
      if (!alive) return;
      setTick((t) => t + 1);
      setOnline(store.online);
      setSyncing(store._syncing);
      if (e.detail === 'auth') store.currentUser().then((u) => alive && setUser(u));
    };
    store.addEventListener('change', onChange);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      alive = false;
      store.removeEventListener('change', onChange);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { tick, online, user, syncing, refresh };
}
