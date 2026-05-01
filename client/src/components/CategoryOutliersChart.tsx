import { useState, useEffect, useRef, type ReactNode } from "react";
import type { CategoryOutliersData } from "@/types";

function fmtCompact(n: number): string {
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1_000)  return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

interface CategoryOutliersChartProps {
  data: CategoryOutliersData;
  /** Reduces row height slightly for denser layouts (default: false). */
  compact?: boolean;
  /** Override the default title + subtitle row with custom content. */
  header?: ReactNode;
}

export function CategoryOutliersChart({ data, compact = false, header }: CategoryOutliersChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { outliers, currentMonthLabel, previousMonthLabel, comparisonNote } = data;

  if (outliers.length === 0) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center text-xs text-muted-foreground">
        No category shifts to display
      </div>
    );
  }

  // ── Dimensions ─────────────────────────────────────────────────────────────
  const ROW_H   = compact ? 28 : 32;  // px per row
  const DOT_R   = 4.5; // current-month dot radius
  const GHOST_R = 3.5; // previous-month dot radius
  const LABEL_W = 118; // wider label column for less truncation
  const DELTA_W     = 52;  // right column for the delta badge
  const CHART_PAD_L = 10;  // guard zone between label edge and leftmost possible dot
  const CHART_PAD_R = 6;   // right padding inside chart area

  const chartW = Math.max(width - LABEL_W - DELTA_W, 0);
  const svgH   = outliers.length * ROW_H;

  // Fixed scale [0, SCALE_MAX]. Falls back to data max when no budget is configured.
  const maxAmount = Math.max(...outliers.flatMap((o) => [o.currentAmount, o.previousAmount]), 1);
  const SCALE_MAX = data.scaleCap ?? maxAmount;

  // Map a value to x, clamped to the visible scale range
  const innerW = chartW - CHART_PAD_L - CHART_PAD_R;
  const xOf = (v: number) =>
    LABEL_W + CHART_PAD_L + (Math.max(0, Math.min(v, SCALE_MAX)) / SCALE_MAX) * innerW;

  // Boundary x-coordinates (used for chevron placement)
  const xRight = LABEL_W + CHART_PAD_L + innerW; // right boundary = SCALE_MAX
  const xLeft  = LABEL_W + CHART_PAD_L;           // left boundary  = $0

  const colorUp    = "var(--color-destructive)";
  const colorDown  = "var(--color-success)";
  const colorMuted = "var(--color-muted-foreground)";
  const colorCard  = "var(--color-card)";

  const fmtAmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  return (
    <div className="w-full">
      {header ?? (
        <>
          <p className="text-sm font-medium text-card-foreground">Largest Changes by Category</p>
          <p className="mb-2 text-xs text-muted-foreground">
            vs {previousMonthLabel} · {comparisonNote}
          </p>
        </>
      )}

      <div className="rounded-md border border-border p-3">
        <div ref={containerRef} className="w-full">
          {width > 0 && (
            <svg width={width} height={svgH} style={{ overflow: "visible" }}>
              {/* Vertical gridlines — 0 anchors the left boundary, matching Monthly Spending style */}
              {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                const x = LABEL_W + CHART_PAD_L + frac * (chartW - CHART_PAD_L - CHART_PAD_R);
                return (
                  <line
                    key={frac}
                    x1={x} y1={0} x2={x} y2={svgH}
                    stroke="var(--color-border)"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                );
              })}

              {outliers.map((o, i) => {
                const y         = i * ROW_H + ROW_H / 2;
                const xPrev     = xOf(o.previousAmount);
                const xCur      = xOf(o.currentAmount);
                const increase  = o.delta > 0;
                const lineColor = increase ? colorUp : colorDown;
                const label     = o.categoryName.length > 15
                  ? o.categoryName.slice(0, 14) + "…"
                  : o.categoryName;
                const deltaStr  = (increase ? "+" : "−") + fmtCompact(Math.abs(o.delta));
                const isHovered = hoveredIdx === i;

                // ── Hover label collision avoidance ──────────────────────────
                const MIN_LABEL_GAP = 58;
                const separation    = Math.abs(xCur - xPrev);

                let prevLabelX: number, prevLabelAnchor: "middle" | "end" | "start";
                let curLabelX:  number, curLabelAnchor:  "middle" | "end" | "start";

                if (separation >= MIN_LABEL_GAP) {
                  prevLabelX = xPrev; prevLabelAnchor = "middle";
                  curLabelX  = xCur;  curLabelAnchor  = "middle";
                } else {
                  const leftX      = Math.min(xPrev, xCur);
                  const rightX     = Math.max(xPrev, xCur);
                  const prevIsLeft = xPrev <= xCur;
                  prevLabelX      = prevIsLeft ? leftX  - 5 : rightX + 5;
                  prevLabelAnchor = prevIsLeft ? "end"      : "start";
                  curLabelX       = prevIsLeft ? rightX + 5 : leftX  - 5;
                  curLabelAnchor  = prevIsLeft ? "start"    : "end";
                }

                // Overflow detection — is either endpoint outside [0, SCALE_MAX]?
                const prevHigh = o.previousAmount > SCALE_MAX;
                const prevLow  = o.previousAmount < 0;
                const curHigh  = o.currentAmount  > SCALE_MAX;
                const curLow   = o.currentAmount  < 0;

                // Clipped half-circle for out-of-bounds endpoints.
                const ClippedDot = ({
                  cx, r, side, fill, stroke, strokeWidth,
                }: {
                  cx: number; r: number; side: "right" | "left";
                  fill: string; stroke?: string; strokeWidth?: number;
                }) => {
                  const sweep = side === "right" ? 0 : 1;
                  return (
                    <path
                      d={`M ${cx} ${y - r} A ${r} ${r} 0 0 ${sweep} ${cx} ${y + r}`}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={strokeWidth}
                    />
                  );
                };

                return (
                  <g key={o.categoryId ?? "__uncat__"}>
                    {/* Row background */}
                    <rect
                      x={0} y={i * ROW_H} width={width} height={ROW_H}
                      fill="var(--color-muted)"
                      fillOpacity={isHovered ? 0.28 : i % 2 === 0 ? 0.15 : 0}
                    />

                    {/* Category label */}
                    <text
                      x={LABEL_W - 6} y={y + 4}
                      textAnchor="end" fontSize={11} fill={colorMuted}
                    >
                      {label}
                    </text>

                    {/* Connecting line — drawn between clamped positions */}
                    <line
                      x1={xPrev} y1={y} x2={xCur} y2={y}
                      stroke={lineColor} strokeWidth={2}
                    />

                    {/* Previous month endpoint: ghost dot or clipped half-circle */}
                    {prevHigh ? (
                      <ClippedDot cx={xRight} r={GHOST_R} side="right"
                        fill={colorCard} stroke={colorMuted} strokeWidth={1.5}
                      />
                    ) : prevLow ? (
                      <ClippedDot cx={xLeft} r={GHOST_R} side="left"
                        fill={colorCard} stroke={colorMuted} strokeWidth={1.5}
                      />
                    ) : (
                      <circle cx={xPrev} cy={y} r={GHOST_R}
                        fill={colorCard} stroke={colorMuted} strokeWidth={1.5}
                      />
                    )}

                    {/* Current month endpoint: filled dot or clipped half-circle */}
                    {curHigh ? (
                      <ClippedDot cx={xRight} r={DOT_R} side="right"
                        fill={lineColor}
                      />
                    ) : curLow ? (
                      <ClippedDot cx={xLeft} r={DOT_R} side="left"
                        fill={lineColor}
                      />
                    ) : (
                      <circle cx={xCur} cy={y} r={DOT_R} fill={lineColor} />
                    )}

                    {/* Delta badge */}
                    <text
                      x={width - 2} y={y + 4}
                      textAnchor="end" fontSize={11} fontWeight={600} fill={lineColor}
                    >
                      {deltaStr}
                    </text>

                    {/* Hover value labels — always show true amounts regardless of capping */}
                    {isHovered && (
                      <>
                        <text
                          x={prevLabelX} y={y - 9}
                          textAnchor={prevLabelAnchor}
                          fontSize={10} fill={colorMuted}
                        >
                          {previousMonthLabel} {fmtAmt(o.previousAmount)}
                        </text>
                        <text
                          x={curLabelX} y={y - 9}
                          textAnchor={curLabelAnchor}
                          fontSize={10} fontWeight={600} fill={lineColor}
                        >
                          {currentMonthLabel} {fmtAmt(o.currentAmount)}
                        </text>
                      </>
                    )}

                    {/* Transparent full-row hover target */}
                    <rect
                      x={0} y={i * ROW_H} width={width} height={ROW_H}
                      fill="transparent"
                      style={{ cursor: "default" }}
                      onMouseEnter={() => setHoveredIdx(i)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    />
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Centered legend */}
        <div className="mt-3 flex items-center justify-center gap-5">
          <div className="flex items-center gap-1.5">
            <svg width={11} height={11}>
              <circle cx={5.5} cy={5.5} r={GHOST_R}
                fill={colorCard} stroke={colorMuted} strokeWidth={1.5}
              />
            </svg>
            <span className="text-xs text-muted-foreground">{previousMonthLabel}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width={11} height={11}>
              <circle cx={5.5} cy={5.5} r={DOT_R} fill={colorMuted} />
            </svg>
            <span className="text-xs text-muted-foreground">{currentMonthLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
