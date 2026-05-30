import { useEffect, useRef, useState } from "react";
import type { SpendingVelocityData } from "@/types";

interface SpendingVelocitySparklineProps {
  data: SpendingVelocityData;
  height?: number;
}

export function SpendingVelocitySparkline({ data, height = 72 }: SpendingVelocitySparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { days, totalBudget, daysInMonth, lastKnownDay } = data;

  if (width === 0 || lastKnownDay === 0) return <div ref={containerRef} style={{ height }} />;

  const PAD_X = 2;
  const PAD_Y = 4;
  const innerW = width  - PAD_X * 2;
  const innerH = height - PAD_Y * 2;

  // Compute max y for scale: max of actual cumulative, expected-at-end (budget), or final actual
  const actualMax    = Math.max(...days.map((d) => d.cumulative ?? 0), 1);
  const budgetMax    = totalBudget ?? 0;
  const yMax         = Math.max(actualMax, budgetMax) * 1.05;

  const xOf  = (day: number)    => PAD_X + ((day - 1) / (daysInMonth - 1)) * innerW;
  const yOf  = (amount: number) => PAD_Y + innerH - (amount / yMax) * innerH;

  // Actual cumulative spend polyline (only up to lastKnownDay)
  const actualPoints = days
    .filter((d) => d.cumulative !== null && d.day <= lastKnownDay)
    .map((d) => `${xOf(d.day)},${yOf(d.cumulative!)}`);

  // Budget pace: straight line from (day 1, 0) to (daysInMonth, totalBudget)
  const budgetPoints = totalBudget
    ? [`${xOf(1)},${yOf(0)}`, `${xOf(daysInMonth)},${yOf(totalBudget)}`]
    : null;

  // Today vertical marker
  const todayX = lastKnownDay > 0 && lastKnownDay < daysInMonth ? xOf(lastKnownDay) : null;
  const latestCumulative = days[lastKnownDay - 1]?.cumulative ?? 0;

  // Over-budget: fill area between actual and budget pace in red
  const isOverBudget = totalBudget !== null && latestCumulative > totalBudget;

  return (
    <div ref={containerRef} className="w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} style={{ overflow: "visible" }}>
          {/* Budget pace line */}
          {budgetPoints && (
            <polyline
              points={budgetPoints.join(" ")}
              fill="none"
              stroke="var(--color-muted-foreground)"
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
            />
          )}

          {/* Actual cumulative spend — filled area under curve */}
          {actualPoints.length >= 2 && (
            <>
              <defs>
                <linearGradient id="velGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={isOverBudget ? "var(--color-down)" : "var(--color-primary)"} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={isOverBudget ? "var(--color-down)" : "var(--color-primary)"} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <polygon
                points={[
                  `${xOf(1)},${yOf(0)}`,
                  ...actualPoints,
                  `${xOf(lastKnownDay)},${yOf(0)}`,
                ].join(" ")}
                fill="url(#velGradient)"
              />
              <polyline
                points={actualPoints.join(" ")}
                fill="none"
                stroke={isOverBudget ? "var(--color-down)" : "var(--color-primary)"}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}

          {/* Today marker — subtle vertical line */}
          {todayX !== null && (
            <line
              x1={todayX} y1={PAD_Y}
              x2={todayX} y2={PAD_Y + innerH}
              stroke="var(--color-muted-foreground)"
              strokeWidth={1}
              strokeOpacity={0.3}
            />
          )}

        </svg>
      )}
    </div>
  );
}
