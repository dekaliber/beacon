import { createContext, useContext, useState, useCallback, useMemo } from "react";
import { getOrCreateDemoScale, DEMO_MODE_KEY } from "@/lib/demo";

interface DemoContextValue {
  isDemoMode: boolean;
  demoFactor: number;
  toggleDemoMode: () => void;
}

const DemoContext = createContext<DemoContextValue>({
  isDemoMode: false,
  demoFactor: 1,
  toggleDemoMode: () => {},
});

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [isDemoMode, setIsDemoMode] = useState(
    () => localStorage.getItem(DEMO_MODE_KEY) === "true"
  );
  const [demoFactor] = useState(() => getOrCreateDemoScale());

  const toggleDemoMode = useCallback(() => {
    setIsDemoMode((prev) => {
      const next = !prev;
      localStorage.setItem(DEMO_MODE_KEY, String(next));
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ isDemoMode, demoFactor, toggleDemoMode }),
    [isDemoMode, demoFactor, toggleDemoMode]
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo() {
  return useContext(DemoContext);
}
