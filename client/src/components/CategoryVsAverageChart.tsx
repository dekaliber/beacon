import { useState, useEffect, useRef, type MouseEvent } from "react";
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
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

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
      <div className="flex h-full min-h-[120px] items-center justify-center tp-caption">
        Not enough history to compute averages
      </div>
    );
  }

  const ROW_H     = compact ? 28 : 32;
  const BAR_H     = compact ? 10 : 12;
  const AVG_TICK_H = ROW_H * 0.65; // height of the average tick mark
  const DELTA_W   = 60;

  const maxLabelChars = Math.max(
    ...categories.map((c) => Math.min(c.categoryName.length, 15)),
    1,
  );
  const LABEL_W = Math.ceil(maxLabelChars * 6.5) + 12;
  const CHART_PAD_L = 10;
  const CHART_PAD_R = 6;

  const chartW = Math.max(width - LABEL_W - DELTA_W, 0);
  const svgH   = categories.length * ROW_H;

  const maxVal = Math.max(...categories.flatMap((c) => [c.currentAmount, c.avgAmount]), 1);
  const innerW = chartW - CHART_PAD_L - CHART_PAD_R;

  const xOf = (v: number) =>
    LABEL_W + CHART_PAD_L + (Math.max(0, Math.min(v, maxVal)) / maxVal) * innerW;

  const colorUp    = "var(--color-down)";
  const colorDown  = "var(--color-up)";
  const colorMuted = "var(--color-muted-foreground)";

  const fmtAmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  return (
    <div className="w-full">
      <h3 className="tp-card-title">Spending vs. Category Averages</h3>
      <p className="mt-0.5 mb-2 tp-caption">
        Current month spend compared to {yearLabel} averages
      </p>

      <div className="relative rounded-md py-3">
        <div ref={containerRef} className="w-full">
          {width > 0 && (
            <svg width={width} height={svgH} style={{ overflow: "visible" }}>
              <defs>
                <pattern id="pending-stripe" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="2" height="4" fill="white" fillOpacity={0.55} />
                </pattern>
              </defs>
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
                const isHovered  = hoveredIdx === i;
                const label      = c.categoryName.length > 15
                  ? c.categoryName.slice(0, 14) + "…"
                  : c.categoryName;

                const pendingAmt  = c.pendingAmount ?? 0;
                const recordedAmt = Math.max(0, c.currentAmount - pendingAmt);
                const xRecorded   = xOf(recordedAmt);

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
                      textAnchor="end" fontSize={12} fill={colorMuted}
                    >
                      {label}
                    </text>

                    {/* Average track (light gray full background bar) */}
                    <rect
                      x={xBase} y={barY} width={Math.max(0, xAvg - xBase)} height={BAR_H}
                      rx={2} fill="var(--color-muted-foreground)" fillOpacity={0.2}
                    />

                    {/* Recorded (non-pending) portion of current bar */}
                    <rect
                      x={xBase} y={barY} width={Math.max(0, xRecorded - xBase)} height={BAR_H}
                      rx={2} fill={barColor} fillOpacity={0.75}
                    />

                    {/* Pending portion: faded base + diagonal stripe overlay */}
                    {pendingAmt > 0 && xCur > xRecorded && (
                      <>
                        <rect
                          x={xRecorded} y={barY} width={Math.max(0, xCur - xRecorded)} height={BAR_H}
                          rx={2} fill={barColor} fillOpacity={0.35}
                        />
                        <rect
                          x={xRecorded} y={barY} width={Math.max(0, xCur - xRecorded)} height={BAR_H}
                          rx={2} fill="url(#pending-stripe)"
                        />
                      </>
                    )}

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
                      textAnchor="end" fontSize={12} fontWeight={600} fill={barColor}
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {deltaStr}
                    </text>

                    {/* Transparent hover target */}
                    <rect
                      x={0} y={y} width={width} height={ROW_H}
                      fill="transparent"
                      style={{ cursor: "default" }}
                      onMouseEnter={() => setHoveredIdx(i)}
                      onMouseLeave={() => { setHoveredIdx(null); setMousePos(null); }}
                      onMouseMove={(e: MouseEvent<SVGRectElement>) => {
                        const parentRect = containerRef.current!.getBoundingClientRect();
                        setMousePos({ x: e.clientX - parentRect.left, y: e.clientY - parentRect.top });
                      }}
                    />
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Floating tooltip */}
        {hoveredIdx !== null && mousePos !== null && (() => {
          const c = categories[hoveredIdx];
          const isOver   = c.delta > 0;
          const barColor = isOver ? colorUp : colorDown;
          const pctStr   = c.deltaPercent !== null
            ? ` (${isOver ? "+" : ""}${c.deltaPercent}%)`
            : "";
          const pendingAmtTip = c.pendingAmount ?? 0;
          const TOOLTIP_MIN_W = 200;
          const left = Math.max(0, Math.min(mousePos.x - TOOLTIP_MIN_W / 2, width - TOOLTIP_MIN_W));
          return (
            <div
              className="pointer-events-none absolute z-10 rounded border border-border bg-background px-3 py-2 text-xs shadow-md"
              style={{ left, top: mousePos.y - 8, minWidth: TOOLTIP_MIN_W, transform: "translateY(-100%)" }}
            >
              <p className="mb-1.5 font-medium">{c.categoryName}</p>
              <div className="grid gap-x-3 gap-y-1" style={{ gridTemplateColumns: "max-content 1fr" }}>
                <span className="text-muted-foreground">Category Avg</span>
                <span className="font-medium">{fmtAmt(c.avgAmount)}</span>
                <span className="text-muted-foreground">Current Month</span>
                <span className="font-semibold" style={{ color: barColor }}>
                  <span>{fmtAmt(c.currentAmount)}{pctStr}</span>
                  {pendingAmtTip > 0 && (
                    <span className="block tp-fineprint italic">({fmtAmt(pendingAmtTip)} pending)</span>
                  )}
                </span>
              </div>
            </div>
          );
        })()}

        {/* Legend */}
        <div className="mt-3 flex items-center justify-center gap-5">
          <div className="flex items-center gap-1.5">
            <svg width={20} height={12}>
              <rect x={0} y={2} width={20} height={8} rx={2} fill="var(--color-muted-foreground)" fillOpacity={0.75} />
            </svg>
            <span className="tp-fineprint">This month</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width={20} height={12}>
              <defs>
                <pattern id="legend-stripe" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="2" height="4" fill="white" fillOpacity={0.55} />
                </pattern>
              </defs>
              <rect x={0} y={2} width={20} height={8} rx={2} fill="var(--color-muted-foreground)" fillOpacity={0.35} />
              <rect x={0} y={2} width={20} height={8} rx={2} fill="url(#legend-stripe)" />
            </svg>
            <span className="tp-fineprint">Pending</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width={12} height={12}>
              <line x1={6} y1={0} x2={6} y2={12} stroke="var(--color-muted-foreground)" strokeWidth={2} />
            </svg>
            <span className="tp-fineprint">12-mo avg</span>
          </div>
        </div>
      </div>
    </div>
  );
}
