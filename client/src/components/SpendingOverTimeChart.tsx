import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Card, CardHeader, CardTitle } from "@/components/Card";
import { useApi } from "@/hooks/useApi";
import { getCategoryTrend } from "@/api";

const DRILL_PALETTE = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
];

function fmtCompact(v: number) {
  if (v === 0) return "";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(v)).toLocaleString()}`;
}

function yTickFormatter(v: number) {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1000) {
    const k = abs / 1000;
    return `${sign}$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `${sign}$${Math.round(abs)}`;
}

export function SpendingOverTimeChart({ year, month }: { year: number; month: number }) {
  const [drillCategory, setDrillCategory] = useState<{ id: string; name: string } | null>(null);
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const isCurrentYear = year === new Date().getFullYear();
  const title = isCurrentYear ? "Spending by Category YTD" : `Spending by Category ${year}`;

  const { data: categoryTrend } = useApi(
    () => getCategoryTrend(year, month, drillCategory?.id),
    [year, month, drillCategory?.id],
  );

  if (!categoryTrend || categoryTrend.series.length === 0) return null;

  const series = drillCategory
    ? categoryTrend.series.map((s, i) => ({ ...s, color: DRILL_PALETTE[i % DRILL_PALETTE.length] }))
    : categoryTrend.series;

  const chartData = categoryTrend.months.map((label, i) => {
    const point: Record<string, unknown> = { label };
    for (const s of series) point[s.name] = s.values[i];
    return point;
  });

  const handleDrillIn = (s: { categoryId: string; name: string; hasChildren: boolean }) => {
    if (!s.hasChildren) return;
    setDrillCategory({ id: s.categoryId, name: s.name });
    setHoveredCategory(null);
  };

  const handleDrillOut = () => {
    setDrillCategory(null);
    setHoveredCategory(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <div className="mt-0.5 flex items-center gap-1 text-sm">
          {drillCategory ? (
            <button onClick={handleDrillOut} className="text-primary hover:underline">
              All categories
            </button>
          ) : (
            <span className="text-muted-foreground">All categories</span>
          )}
          {drillCategory && (
            <>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">{drillCategory.name}</span>
            </>
          )}
        </div>
      </CardHeader>
      <div className="flex" onMouseLeave={() => setHoveredCategory(null)}>
        <div className="flex flex-col justify-start gap-3 pr-3 py-2 w-44 shrink-0">
          {series.map((s) => (
            <button
              key={s.categoryId}
              className="flex items-center gap-1.5 text-xs text-left transition-opacity"
              style={{
                opacity: hoveredCategory === null || hoveredCategory === s.name ? 1 : 0.35,
                cursor: s.hasChildren ? "pointer" : "default",
              }}
              onMouseEnter={() => setHoveredCategory(s.name)}
              onMouseLeave={() => setHoveredCategory(null)}
              onClick={() => handleDrillIn(s)}
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className={s.hasChildren ? "hover:underline" : ""}>{s.name}</span>
              {s.hasChildren && <ChevronRight className="h-3 w-3 opacity-50" />}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <ResponsiveContainer width="100%" height={480}>
            <LineChart data={chartData} margin={{ top: 32, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="label" fontSize={12} axisLine={false} tickLine={false} />
              <YAxis
                axisLine={false}
                tickLine={false}
                width={48}
                tick={(props: any) => {
                  if (props.index === 0) return <g />;
                  return (
                    <text x={props.x} y={props.y} dy={4} textAnchor="end" fontSize={12} fill="var(--color-muted-foreground)">
                      {yTickFormatter(props.payload.value)}
                    </text>
                  );
                }}
              />
              <Tooltip content={() => null} cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }} />
              {series.map((s) => {
                const isHovered = hoveredCategory === s.name;
                const anyHovered = hoveredCategory !== null;
                return (
                  <Line
                    key={s.categoryId}
                    type="step"
                    dataKey={s.name}
                    stroke={s.color}
                    strokeWidth={isHovered ? 2.5 : 1.5}
                    strokeOpacity={anyHovered ? (isHovered ? 1 : 0.15) : 0.35}
                    isAnimationActive={false}
                    style={{ cursor: s.hasChildren ? "pointer" : "default" }}
                    onClick={() => handleDrillIn(s)}
                    dot={
                      isHovered
                        ? (props: any) => {
                            const { cx, cy, value, index } = props;
                            if (!value) return <g key={`d-${index}`} />;
                            return (
                              <g key={`d-${index}`}>
                                <circle cx={cx} cy={cy} r={3} fill={s.color} stroke="white" strokeWidth={1.5} />
                                <text
                                  x={cx}
                                  y={cy - 10}
                                  textAnchor="middle"
                                  fontSize={10}
                                  fill={s.color}
                                  fontWeight="600"
                                >
                                  {fmtCompact(value)}
                                </text>
                              </g>
                            );
                          }
                        : false
                    }
                    activeDot={isHovered ? { r: 4, fill: s.color, stroke: "white", strokeWidth: 1.5 } : false}
                    onMouseEnter={() => setHoveredCategory(s.name)}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}
