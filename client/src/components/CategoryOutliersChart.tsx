import { useState, useEffect, useRef, type ReactNode } from "react";
import type { CategoryOutliersData } from "@/types";

const fmtAmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const fmtDelta = (n: number) => {
  const sign = n >= 0 ? "+" : "−";
  return sign + new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
};

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
      <div className="flex h-full min-h-[120px] items-center justify-center tp-caption">
        No category shifts to display
      </div>
    );
  }

  // ── Dimensions ─────────────────────────────────────────────────────────────
  const ROW_H       = compact ? 28 : 32;
  const HEADER_H    = 18;
  const DOT_R       = 4.5;
  const GHOST_R     = 3.5;
  const CUR_W       = 80;
  const PREV_W      = 80;
  const DELTA_W     = 88;
  const CHART_PAD_L = 10;
  const CHART_PAD_R = 8;

  const maxLabelChars  = Math.max(...outliers.map((o) => Math.min(o.categoryName.length, 17)), 1);
  const LABEL_W        = Math.ceil(maxLabelChars * 6.5) + 12;

  const colsW          = CUR_W + PREV_W + DELTA_W;
  const chartAreaRight = Math.max(width - colsW, LABEL_W + CHART_PAD_L + CHART_PAD_R + 1);
  const chartW         = chartAreaRight - LABEL_W;
  const innerW         = Math.max(chartW - CHART_PAD_L - CHART_PAD_R, 0);
  const svgH           = HEADER_H + outliers.length * ROW_H;

  const maxAmount = Math.max(...outliers.flatMap((o) => [o.currentAmount, o.previousAmount]), 1);
  const SCALE_MAX = data.scaleCap ?? maxAmount;

  const xOf = (v: number) =>
    LABEL_W + CHART_PAD_L + (Math.max(0, Math.min(v, SCALE_MAX)) / SCALE_MAX) * innerW;

  const xRight = LABEL_W + CHART_PAD_L + innerW;
  const xLeft  = LABEL_W + CHART_PAD_L;

  // Right edge of each column (text is right-aligned within the column)
  const curColX   = chartAreaRight + CUR_W   - 4;
  const prevColX  = chartAreaRight + CUR_W + PREV_W  - 4;
  const deltaColX = width - 4;

  const colorUp    = "var(--color-destructive)";
  const colorDown  = "var(--color-success)";
  const colorMuted = "var(--color-muted-foreground)";
  const colorCard  = "var(--color-card)";

  return (
    <div className="w-full">
      {header ?? (
        <>
          <h3 className="tp-card-title">Largest Changes by Category</h3>
          <p className="mt-0.5 mb-2 tp-caption">
            vs {previousMonthLabel} · {comparisonNote}
          </p>
        </>
      )}

      <div className="rounded-md py-3">
        <div ref={containerRef} className="w-full">
          {width > 0 && (
            <svg width={width} height={svgH} style={{ overflow: "visible" }}>
              {/* Column headers */}
              <text x={curColX}   y={HEADER_H - 5} textAnchor="end" fontSize={10} fill={colorMuted}>{currentMonthLabel}</text>
              <text x={prevColX}  y={HEADER_H - 5} textAnchor="end" fontSize={10} fill={colorMuted}>{previousMonthLabel}</text>
              <text x={deltaColX} y={HEADER_H - 5} textAnchor="end" fontSize={10} fill={colorMuted}>Change</text>

              {/* Vertical gridlines — only within chart area, below header */}
              {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                const x = LABEL_W + CHART_PAD_L + frac * innerW;
                return (
                  <line
                    key={frac}
                    x1={x} y1={HEADER_H} x2={x} y2={svgH}
                    stroke="var(--color-border)"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                );
              })}

              {outliers.map((o, i) => {
                const y         = HEADER_H + i * ROW_H + ROW_H / 2;
                const xPrev     = xOf(o.previousAmount);
                const xCur      = xOf(o.currentAmount);
                const increase  = o.delta > 0;
                const lineColor = increase ? colorUp : colorDown;
                const label     = o.categoryName.length > 17
                  ? o.categoryName.slice(0, 16) + "…"
                  : o.categoryName;
                const isHovered = hoveredIdx === i;

                const prevHigh = o.previousAmount > SCALE_MAX;
                const prevLow  = o.previousAmount < 0;
                const curHigh  = o.currentAmount  > SCALE_MAX;
                const curLow   = o.currentAmount  < 0;

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
                      x={0} y={HEADER_H + i * ROW_H} width={width} height={ROW_H}
                      fill="var(--color-muted)"
                      fillOpacity={isHovered ? 0.28 : i % 2 === 0 ? 0.15 : 0}
                    />

                    {/* Category label */}
                    <text
                      x={LABEL_W - 6} y={y + 4}
                      textAnchor="end" fontSize={12} fill={colorMuted}
                    >
                      {label}
                    </text>

                    {/* Connecting line */}
                    <line
                      x1={xPrev} y1={y} x2={xCur} y2={y}
                      stroke={lineColor} strokeWidth={2}
                    />

                    {/* Previous endpoint */}
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

                    {/* Current endpoint */}
                    {curHigh ? (
                      <ClippedDot cx={xRight} r={DOT_R} side="right" fill={lineColor} />
                    ) : curLow ? (
                      <ClippedDot cx={xLeft} r={DOT_R} side="left" fill={lineColor} />
                    ) : (
                      <circle cx={xCur} cy={y} r={DOT_R} fill={lineColor} />
                    )}

                    {/* Amount columns */}
                    <text x={curColX}   y={y + 4} textAnchor="end" fontSize={12} fill={colorMuted} style={{ fontFamily: "var(--font-mono)" }}>
                      {fmtAmt(o.currentAmount)}
                    </text>
                    <text x={prevColX}  y={y + 4} textAnchor="end" fontSize={12} fill={colorMuted} style={{ fontFamily: "var(--font-mono)" }}>
                      {fmtAmt(o.previousAmount)}
                    </text>
                    <text x={deltaColX} y={y + 4} textAnchor="end" fontSize={12} fontWeight={600} fill={lineColor} style={{ fontFamily: "var(--font-mono)" }}>
                      {fmtDelta(o.delta)}
                    </text>

                    {/* Full-row hover target */}
                    <rect
                      x={0} y={HEADER_H + i * ROW_H} width={width} height={ROW_H}
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

        {/* Legend */}
        <div className="mt-3 flex items-center justify-center gap-5">
          <div className="flex items-center gap-1.5">
            <svg width={11} height={11}>
              <circle cx={5.5} cy={5.5} r={GHOST_R}
                fill={colorCard} stroke={colorMuted} strokeWidth={1.5}
              />
            </svg>
            <span className="tp-fineprint">{previousMonthLabel}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width={11} height={11}>
              <circle cx={5.5} cy={5.5} r={DOT_R} fill={colorMuted} />
            </svg>
            <span className="tp-fineprint">{currentMonthLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
