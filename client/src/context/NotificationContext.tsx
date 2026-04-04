import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { getNotifications } from "@/api";
import type { NotificationData } from "@/types";

interface NotificationContextValue {
  notifications: NotificationData | null;
  loading: boolean;
  refetch: () => void;
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: null,
  loading: false,
  refetch: () => {},
});

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationData | null>(null);
  const [loading, setLoading] = useState(true);
  // Prevents the initial fetch from firing twice in React StrictMode, which
  // mounts → unmounts → remounts every component in development. The ref
  // survives the simulated unmount so the second effect invocation is a no-op.
  const hasFetched = useRef(false);

  const fetch = useCallback(async () => {
    try {
      const data = await getNotifications();
      setNotifications(data);
    } catch {
      // Non-fatal — bell just shows no badge if the request fails
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch once on mount (app load)
  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    fetch();
  }, [fetch]);

  return (
    <NotificationContext.Provider value={{ notifications, loading, refetch: fetch }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
