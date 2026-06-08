import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  /** Show-delay in ms before the tooltip appears (default 400). */
  delay?: number;
}

/**
 * Hover tooltip for icon-only action buttons (trailing edit/delete/etc.).
 * Opaque surface, a small show-delay, and a subtle fade-in (see `.animate-tooltip-in`).
 */
export function Tooltip({ content, children, delay = 400 }: TooltipProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = () => {
    timerRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const r = triggerRef.current.getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top });
      }
    }, delay);
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setPos(null);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <span ref={triggerRef} className="inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos && createPortal(
        <div
          className="pointer-events-none fixed z-[9999]"
          style={{ left: pos.x, top: pos.y, transform: "translate(-50%, calc(-100% - 8px))" }}
        >
          <div className="animate-tooltip-in">
            <div className="rounded bg-background border border-border text-foreground text-xs shadow-pop px-2.5 py-1.5 whitespace-nowrap">
              {content}
            </div>
            <div className="w-2 h-2 bg-background border-b border-r border-border rotate-45 mx-auto -mt-[5px]" />
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}
