import { createContext, useContext, useCallback, useEffect, useState } from "react";
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
  useEffect(() => { fetch(); }, [fetch]);

  return (
    <NotificationContext.Provider value={{ notifications, loading, refetch: fetch }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
