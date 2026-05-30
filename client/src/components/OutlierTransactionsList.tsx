import type { OutlierCategoryGroup } from "@/types";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import { StatValue } from "@/components/Typography";

function fmtAmount(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso: string) {
  const [, m, d] = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m) - 1]} ${parseInt(d)}`;
}

interface OutlierTransactionsListProps {
  categories: OutlierCategoryGroup[];
}

export function OutlierTransactionsList({ categories }: OutlierTransactionsListProps) {
  if (categories.length === 0) return null;

  return (
    <div className="w-full">
      <h3 className="tp-card-title">Spending Outliers</h3>
      <p className="mt-0.5 mb-3 tp-caption">Largest transactions driving above average category spend</p>
      <div className="space-y-4">
        {categories.map((cat) => {
          const excessPct = Math.round((cat.excess / cat.historicalAvgMonthly) * 100);
          return (
            <div key={cat.categoryId ?? "__unknown__"}>
              {/* Category header */}
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 tp-row-label">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: cat.categoryColor }}
                  />
                  {cat.categoryName}
                </span>
                <span className="flex items-center gap-1.5 tp-fineprint">
                  <StatValue className="font-medium text-ink">{fmtAmount(cat.currentMonthTotal)}</StatValue>
                  <span>vs {fmtAmount(cat.historicalAvgMonthly)} avg</span>
                  <StatValue className="font-medium text-down">+{excessPct}%</StatValue>
                </span>
              </div>

              {/* Transactions contributing to the excess */}
              <div className="space-y-0.5 pl-3.5">
                {cat.transactions.map((t) => (
                  <div
                    key={t.id}
                    className={`flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/40 ${t.isPending ? "opacity-60" : ""}`}
                  >
                    <span
                      className="shrink-0 inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold leading-none text-white"
                      style={{ backgroundColor: t.isJoint ? JOINT_COLOR : PERSONAL_COLOR }}
                    >
                      {t.isJoint ? "J" : "P"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate tp-row-label">
                        {t.description}
                        {t.vendor && (
                          <span className="ml-1.5 font-normal text-ink-3">{t.vendor}</span>
                        )}
                      </p>
                    </div>
                    {t.isPending && (
                      <span className="shrink-0 tp-fineprint italic">pending</span>
                    )}
                    <span className="shrink-0 tp-fineprint">{fmtDate(t.date)}</span>
                    <StatValue className="shrink-0 tp-numeric">{fmtAmount(t.amount)}</StatValue>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
