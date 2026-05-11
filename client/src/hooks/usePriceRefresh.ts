import { useEffect, useRef, useSyncExternalStore } from "react";
import { getAuthToken } from "@/lib/authToken";
import { isPriceRefreshNeeded, getNextUpdateTime, nextStockCutoff } from "@/lib/priceUtils";
import type { InvestmentHolding } from "@/types";

// ── Module-level singleton ────────────────────────────────────────────────
// Shared across all consumers (Dashboard + Investments) so a single SSE
// connection drives both status lines simultaneously.

interface RefreshState {
  phase: "idle" | "running" | "done";
  count: number;
  total: number;
  completedAt: Date | null;
}

let state: RefreshState = { phase: "idle", count: 0, total: 0, completedAt: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<RefreshState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): RefreshState {
  return state;
}

async function startRefresh(source: string): Promise<void> {
  if (state.phase === "running") return;
  setState({ phase: "running", count: 0, total: 0 });

  try {
    const token = await getAuthToken();
    const res = await fetch(
      `/api/investments/prices/refresh/stream?source=${encodeURIComponent(source)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );

    if (!res.ok || !res.body) {
      setState({ phase: "done", completedAt: new Date() });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === "start") {
            setState({ total: data.total });
          } else if (data.type === "progress") {
            setState({ count: data.count, total: data.total });
          } else if (data.type === "done") {
            setState({ phase: "done", count: data.updated, total: data.total, completedAt: new Date() });
          }
        } catch {
          // ignore malformed SSE events
        }
      }
    }
  } catch {
    setState({ phase: "done", completedAt: new Date() });
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────

interface UsePriceRefreshOptions {
  // Holdings are used for client-side staleness check (Investments page).
  // When null/undefined (Dashboard), the hook triggers a refresh if none has
  // happened this session — the server does its own staleness check.
  holdings?: InvestmentHolding[] | null;
  source: string;
}

interface UsePriceRefreshResult {
  phase: "idle" | "running" | "done";
  count: number;
  total: number;
  // When phase !== "running": the computed next refresh time (null if unknown).
  nextUpdateAt: Date | null;
}

export function usePriceRefresh({ holdings, source }: UsePriceRefreshOptions): UsePriceRefreshResult {
  const refreshState = useSyncExternalStore(subscribe, getSnapshot);
  const triggeredRef = useRef(false);

  useEffect(() => {
    // Attach to an already-running refresh without starting a second one.
    if (refreshState.phase === "running") {
      triggeredRef.current = true;
      return;
    }
    if (triggeredRef.current) return;

    let shouldRefresh: boolean;
    if (holdings != null) {
      // Investments page: proper client-side staleness check.
      shouldRefresh = isPriceRefreshNeeded(holdings);
    } else {
      // Dashboard: trigger once per session; server handles staleness.
      shouldRefresh =
        refreshState.phase === "idle" ||
        (refreshState.completedAt != null &&
          Date.now() - refreshState.completedAt.getTime() > 5 * 60 * 1000);
    }

    if (!shouldRefresh) return;
    triggeredRef.current = true;
    startRefresh(source);
  }, [holdings, refreshState.phase, refreshState.completedAt, source]);

  const nextUpdateAt =
    refreshState.phase !== "running"
      ? holdings != null
        ? getNextUpdateTime(holdings)
        : nextStockCutoff(new Date())
      : null;

  return {
    phase: refreshState.phase,
    count: refreshState.count,
    total: refreshState.total,
    nextUpdateAt,
  };
}
