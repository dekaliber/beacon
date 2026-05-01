import { useState, useEffect, useRef } from "react";
import type { CategoryAverage } from "@/types";

function fmtCompact(n: number): string {
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (n >= 1_000)  return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

interface CategoryVsAverageChartProps {
  categories: CategoryAverage[];
  yearLabel: string;
  /** Reduces row height slightly for denser layouts (default: false). */
  compact?: boolean;
}

export function CategoryVsAverageChart({ categories, yearLabel, compact = false }: CategoryVsAverageChartProps) {
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

  if (categories.length === 0) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center text-xs text-muted-foreground">
        Not enough history to compute averages
      </div>
    );
  }

  const ROW_H     = compact ? 28 : 32;
  const BAR_H     = compact ? 10 : 12;
  const AVG_TICK_H = ROW_H * 0.65; // height of the average tick mark
  const LABEL_W   = 118;
  const DELTA_W   = 60;
  const CHART_PAD_L = 10;
  const CHART_PAD_R = 6;

  const chartW = Math.max(width - LABEL_W - DELTA_W, 0);
  const svgH   = categories.length * ROW_H;

  const maxVal = Math.max(...categories.flatMap((c) => [c.currentAmount, c.avgAmount]), 1);
  const innerW = chartW - CHART_PAD_L - CHART_PAD_R;

  const xOf = (v: number) =>
    LABEL_W + CHART_PAD_L + (Math.max(0, Math.min(v, maxVal)) / maxVal) * innerW;

  const colorUp    = "var(--color-destructive)";
  const colorDown  = "var(--color-success)";
  const colorMuted = "var(--color-muted-foreground)";

  const fmtAmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  return (
    <div className="w-full">
      <p className="text-sm font-medium text-card-foreground">Spending vs. Category Averages</p>
      <p className="mb-2 text-xs text-muted-foreground">
        Current month spend compared to {yearLabel} averages
      </p>

      <div className="rounded-md p-3">
        <div ref={containerRef} className="w-full">
          {width > 0 && (
            <svg width={width} height={svgH} style={{ overflow: "visible" }}>
              {/* Vertical gridlines */}
              {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                const x = LABEL_W + CHART_PAD_L + frac * innerW;
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

              {categories.map((c, i) => {
                const y          = i * ROW_H;
                const yCenter    = y + ROW_H / 2;
                const barY       = yCenter - BAR_H / 2;
                const isOver     = c.delta > 0;
                const barColor   = isOver ? colorUp : colorDown;
                const xAvg       = xOf(c.avgAmount);
                const xCur       = xOf(c.currentAmount);
                const xBase      = LABEL_W + CHART_PAD_L;
                const deltaStr   = (isOver ? "+" : "−") + fmtCompact(Math.abs(c.delta));
                const pctStr     = c.deltaPercent !== null
                  ? ` (${isOver ? "+" : ""}${c.deltaPercent}%)`
                  : "";
                const isHovered  = hoveredIdx === i;
                const label      = c.categoryName.length > 15
                  ? c.categoryName.slice(0, 14) + "…"
                  : c.categoryName;

                return (
                  <g key={c.categoryId ?? `__cat${i}__`}>
                    {/* Row background */}
                    <rect
                      x={0} y={y} width={width} height={ROW_H}
                      fill="var(--color-muted)"
                      fillOpacity={isHovered ? 0.28 : i % 2 === 0 ? 0.15 : 0}
                    />

                    {/* Category label */}
                    <text
                      x={LABEL_W - 6} y={yCenter + 4}
                      textAnchor="end" fontSize={11} fill={colorMuted}
                    >
                      {label}
                    </text>

                    {/* Average track (light gray full background bar) */}
                    <rect
                      x={xBase} y={barY} width={Math.max(0, xAvg - xBase)} height={BAR_H}
                      rx={2} fill="var(--color-muted-foreground)" fillOpacity={0.2}
                    />

                    {/* Current amount bar */}
                    <rect
                      x={xBase} y={barY} width={Math.max(0, xCur - xBase)} height={BAR_H}
                      rx={2} fill={barColor} fillOpacity={0.75}
                    />

                    {/* Average tick mark */}
                    {xAvg > xBase && (
                      <line
                        x1={xAvg} y1={yCenter - AVG_TICK_H / 2}
                        x2={xAvg} y2={yCenter + AVG_TICK_H / 2}
                        stroke={colorMuted} strokeWidth={2}
                      />
                    )}

                    {/* Delta badge */}
                    <text
                      x={width - 2} y={yCenter + 4}
                      textAnchor="end" fontSize={11} fontWeight={600} fill={barColor}
                    >
                      {deltaStr}
                    </text>

                    {/* Hover tooltip — collision-aware label placement */}
                    {isHovered && (() => {
                      const xCurClamped = Math.max(xCur, xBase + 4);
                      const separation  = Math.abs(xCurClamped - xAvg);
                      const MIN_GAP     = 58;

                      let avgX: number, avgAnchor: "middle" | "end" | "start";
                      let curX: number, curAnchor: "middle" | "end" | "start";

                      if (separation >= MIN_GAP) {
                        avgX = xAvg;       avgAnchor = "middle";
                        curX = xCurClamped; curAnchor = xCur > xAvg ? "end" : "start";
                      } else {
                        const leftX     = Math.min(xCurClamped, xAvg);
                        const rightX    = Math.max(xCurClamped, xAvg);
                        const curIsLeft = xCurClamped <= xAvg;
                        curX = curIsLeft ? leftX  - 3 : rightX + 3;
                        curAnchor = curIsLeft ? "end" : "start";
                        avgX = curIsLeft ? rightX + 3 : leftX  - 3;
                        avgAnchor = curIsLeft ? "start" : "end";
                      }

                      return (
                        <>
                          <text x={avgX} y={barY - 5} textAnchor={avgAnchor} fontSize={10} fill={colorMuted}>
                            avg {fmtAmt(c.avgAmount)}
                          </text>
                          <text x={curX} y={barY - 5} textAnchor={curAnchor} fontSize={10} fontWeight={600} fill={barColor}>
                            {fmtAmt(c.currentAmount)}{pctStr}
                          </text>
                        </>
                      );
                    })()}

                    {/* Transparent hover target */}
                    <rect
                      x={0} y={y} width={width} height={ROW_H}
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
            <svg width={20} height={12}>
              <rect x={0} y={2} width={20} height={8} rx={2} fill="var(--color-muted-foreground)" fillOpacity={0.75} />
            </svg>
            <span className="text-xs text-muted-foreground">This month</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width={12} height={12}>
              <line x1={6} y1={0} x2={6} y2={12} stroke="var(--color-muted-foreground)" strokeWidth={2} />
            </svg>
            <span className="text-xs text-muted-foreground">12-mo avg</span>
          </div>
        </div>
      </div>
    </div>
  );
}
