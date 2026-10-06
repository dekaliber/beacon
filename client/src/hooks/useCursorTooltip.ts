import { useState, useLayoutEffect, useRef, type CSSProperties } from "react";

const OFFSET_X = 14;
const OFFSET_Y = 8;
const EDGE_MARGIN = 8;

// Positions a `fixed` tooltip that trails the cursor: above and to the right by
// default, flipped to the left of the cursor when its measured width would run
// past the viewport's right edge. Attach `ref` to the tooltip element.
export function useCursorTooltip(pos: { x: number; y: number } | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);
  const x = pos?.x;

  useLayoutEffect(() => {
    const el = ref.current;
    if (x == null || !el) return;
    setFlipped(x + OFFSET_X + el.offsetWidth > window.innerWidth - EDGE_MARGIN);
  }, [x]);

  const style: CSSProperties = !pos
    ? {}
    : flipped
      ? { left: pos.x - OFFSET_X, top: pos.y - OFFSET_Y, transform: "translate(-100%, -100%)" }
      : { left: pos.x + OFFSET_X, top: pos.y - OFFSET_Y, transform: "translateY(-100%)" };

  return { ref, style };
}
