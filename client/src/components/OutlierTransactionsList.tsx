import type { OutlierCategoryGroup } from "@/types";

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
  if (categories.length === 0) {
    return (
      <div className="flex min-h-[80px] items-center justify-center text-xs text-muted-foreground">
        No categories above their monthly average
      </div>
    );
  }

  return (
    <div className="w-full">
      <p className="text-sm font-medium text-card-foreground">Spending Outliers</p>
      <p className="mb-3 text-xs text-muted-foreground">
        Largest transactions driving above average category spend
      </p>
      <div className="space-y-4">
        {categories.map((cat) => {
          const excessPct = Math.round((cat.excess / cat.historicalAvgMonthly) * 100);
          return (
            <div key={cat.categoryId ?? "__unknown__"}>
              {/* Category header */}
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-card-foreground">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: cat.categoryColor }}
                  />
                  {cat.categoryName}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{fmtAmount(cat.currentMonthTotal)}</span>
                  <span>vs {fmtAmount(cat.historicalAvgMonthly)} avg</span>
                  <span className="font-medium text-destructive">+{excessPct}%</span>
                </span>
              </div>

              {/* Transactions contributing to the excess */}
              <div className="space-y-0.5 pl-3.5">
                {cat.transactions.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">
                        {t.description}
                        {t.vendor && (
                          <span className="ml-1.5 font-normal text-muted-foreground">{t.vendor}</span>
                        )}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(t.date)}</span>
                    <span className="shrink-0 text-xs font-semibold">{fmtAmount(t.amount)}</span>
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
