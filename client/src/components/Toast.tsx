import { useEffect, useRef, useState, useCallback } from "react";
import { X, RotateCcw } from "lucide-react";

// ── Toast item type ──────────────────────────────────────────────────────────

export interface ToastItem {
  id: string;
  message: string;
  onUndo?: () => void;
  /** Auto-dismiss duration in ms. Defaults to 8000. */
  duration?: number;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}

// ── Container ─────────────────────────────────────────────────────────────────
// Renders the stack of toasts anchored to the bottom-right of the viewport.
// New toasts append below older ones; because the container is bottom-anchored
// the whole stack grows upward, so the newest toast is closest to the corner.

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// ── Individual row ────────────────────────────────────────────────────────────

function ToastRow({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => onDismiss(toast.id), toast.duration ?? 8000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.duration, onDismiss]);

  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-lg bg-foreground px-4 py-3 text-sm text-background shadow-lg min-w-[260px] max-w-sm">
      <span className="flex-1">{toast.message}</span>
      {toast.onUndo && (
        <button
          onClick={() => { toast.onUndo?.(); onDismiss(toast.id); }}
          className="flex items-center gap-1 font-semibold shrink-0 opacity-80 hover:opacity-100 transition-opacity"
        >
          <RotateCcw className="h-3 w-3" />
          Undo
        </button>
      )}
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
