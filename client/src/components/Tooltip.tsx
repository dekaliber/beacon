import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleQuestionMark } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Two tooltip recipes, deliberately kept as separate components because they
 * serve different jobs:
 *
 *   <Tooltip>     — names an action. Wraps icon-only buttons (edit/delete/close).
 *                   Compact surface, arrow pointing at the control, and a
 *                   show-delay so sweeping across a row of buttons doesn't flash.
 *   <InfoTooltip> — explains a datum. Wraps a (?) or a non-interactive status
 *                   icon (earnings, stale price). Roomier surface sized for
 *                   prose, no arrow, and appears immediately since the hover is
 *                   deliberate.
 *
 * Both share the positioning below: portalled to <body> so no `overflow`
 * ancestor can clip them, and clamped to the viewport so a tooltip on a
 * rightmost table column doesn't spill off the page.
 */

/** Minimum gap kept between the tooltip and the viewport edge when clamping. */
const EDGE_MARGIN = 8;
/** Gap between the trigger and the tooltip box. */
const GAP = 8;

const COMPACT_SURFACE =
  "rounded bg-background border border-border text-foreground text-xs shadow-pop px-2.5 py-1.5 whitespace-nowrap";

// The CardInfoTooltip recipe this replaced, kept as-is — including the fixed
// w-64. A single column width is what makes multi-line explainers and the
// label/value readouts line up; short one-liners just carry some slack.
const INFO_SURFACE =
  "w-64 whitespace-normal text-left rounded-md bg-background border border-border px-3 py-2 tp-caption shadow-md";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  /** Show-delay in ms before the tooltip appears. */
  delay?: number;
}

function TooltipBase({
  content,
  children,
  delay,
  surface,
  arrow,
}: TooltipProps & { delay: number; surface: string; arrow: boolean }) {
  const [pos, setPos] = useState<{ x: number; top: number; bottom: number } | null>(null);
  const [shift, setShift] = useState(0);
  const [flip, setFlip] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = () => {
    timerRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const r = triggerRef.current.getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
      }
    }, delay);
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setPos(null);
    setShift(0);
    setFlip(false);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Measure once the box is in the DOM and correct any viewport overflow:
  // clamp horizontally, and flip below the trigger when a tall tooltip near the
  // top of the page wouldn't fit above it. Reads offsetWidth/Height (layout
  // boxes, unaffected by the transform below) so applying the correction can't
  // feed back into the next measurement. Runs before paint, so the corrected
  // position is what actually gets drawn.
  useLayoutEffect(() => {
    if (pos == null || boxRef.current == null) return;
    const half = boxRef.current.offsetWidth / 2;
    let next = 0;
    const overRight = pos.x + half - (window.innerWidth - EDGE_MARGIN);
    if (overRight > 0) next -= overRight;
    // Re-check the left edge afterwards so a tooltip too wide for the viewport
    // pins to the left rather than overshooting past it.
    const overLeft = EDGE_MARGIN - (pos.x - half + next);
    if (overLeft > 0) next += overLeft;
    setShift(next);
    setFlip(pos.top - GAP - boxRef.current.offsetHeight < EDGE_MARGIN);
  }, [pos]);

  const arrowEl = arrow ? (
    <div
      className={cn(
        "w-2 h-2 bg-background border-border rotate-45 mx-auto",
        flip ? "border-t border-l -mb-[5px]" : "border-b border-r -mt-[5px]"
      )}
      // Inline transform replaces the rotate-45 class, so re-apply it here.
      // Counter-shifts the clamp so the arrow keeps pointing at the trigger.
      style={shift !== 0 ? { transform: `translateX(${-shift}px) rotate(45deg)` } : undefined}
    />
  ) : null;

  return (
    <span ref={triggerRef} className="inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos && createPortal(
        <div
          ref={boxRef}
          className="pointer-events-none fixed z-[9999]"
          style={{
            left: pos.x,
            top: flip ? pos.bottom : pos.top,
            transform: `translate(calc(-50% + ${shift}px), ${flip ? `${GAP}px` : `calc(-100% - ${GAP}px)`})`,
          }}
        >
          <div className="animate-tooltip-in">
            {flip && arrowEl}
            <div className={surface}>{content}</div>
            {!flip && arrowEl}
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}

/** Action label for icon-only buttons. Compact, arrowed, delayed. */
export function Tooltip({ content, children, delay = 400 }: TooltipProps) {
  return (
    <TooltipBase content={content} delay={delay} surface={COMPACT_SURFACE} arrow>
      {children}
    </TooltipBase>
  );
}

/** Explainer for a (?) or a non-interactive status icon. Roomy, arrowless, immediate. */
export function InfoTooltip({ content, children, delay = 0 }: TooltipProps) {
  return (
    <TooltipBase content={content} delay={delay} surface={INFO_SURFACE} arrow={false}>
      {children}
    </TooltipBase>
  );
}

/**
 * Ready-made (?) hint: the standard question-mark trigger plus an InfoTooltip.
 * Use this for headings and labels that need a "what is this" explainer; reach
 * for InfoTooltip directly when the trigger is something else (a status icon,
 * a value, a badge).
 */
export function InfoHint({ children }: { children: React.ReactNode }) {
  return (
    <InfoTooltip content={children}>
      <CircleQuestionMark className="h-3.5 w-3.5 cursor-default text-muted-foreground/60" />
    </InfoTooltip>
  );
}
