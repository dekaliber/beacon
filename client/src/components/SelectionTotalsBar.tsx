import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectionTotal {
  label: string;
  /** Null renders an em dash — nothing in the selection carried a value. */
  value: number | null;
  /** "signed" prefixes +/−; "plain" renders a bare amount. */
  tone?: "plain" | "signed";
}

interface SelectionTotalsBarProps {
  count: number;
  totals: SelectionTotal[];
  /** Trailing caveat, e.g. "2 unpriced" when some rows lack a live quote. */
  note?: string;
  /**
   * Vertical offset. Defaults to the BulkEditBar's 96px; pages with a pinned
   * column-header overlay (Options) push it below that so the two don't stack.
   */
  topClassName?: string;
  onClear: () => void;
}

const fmtAbs = (n: number) =>
  Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Read-only sibling of BulkEditBar: same floating pill, but it reports sums for
 * the selected rows instead of offering bulk edits. Every figure renders white
 * on the gradient — the tables' text-up/text-down pair doesn't survive the dark
 * fill, and a signed total carries its direction in the +/− prefix.
 */
export function SelectionTotalsBar({ count, totals, note, topClassName = "top-[96px]", onClear }: SelectionTotalsBarProps) {
  const sepCls = "w-px bg-white/[.18] my-2 self-stretch shrink-0";

  return (
    <div className={cn("fixed left-1/2 z-[46] -translate-x-1/2 inline-flex items-stretch rounded-full bg-gradient-to-b from-primary to-primary-deep text-white text-13 font-normal select-none shadow-[0_1px_0_rgba(255,255,255,.25)_inset,0_14px_34px_-16px_rgba(20,30,80,.35),0_4px_10px_-2px_rgba(15,20,40,.18)]", topClassName)}>
      <span className="flex items-center px-[16px] py-[10px] whitespace-nowrap">
        {count} selected
      </span>

      {totals.map((t) => (
        <div key={t.label} className="flex items-stretch">
          <span className={sepCls} />
          <span className="flex items-center gap-1.5 px-[16px] py-[10px] whitespace-nowrap">
            <span className="text-white/[.7]">{t.label}</span>
            {t.value == null ? (
              <span className="text-white/[.7]">—</span>
            ) : t.tone === "signed" ? (
              // Sign carries the direction; no red tint — against the gradient it
              // reads as an alert rather than as data.
              <span className="font-medium">
                {t.value >= 0 ? "+" : "−"}${fmtAbs(t.value)}
              </span>
            ) : (
              <span className="font-medium">${fmtAbs(t.value)}</span>
            )}
          </span>
        </div>
      ))}

      {note && (
        <>
          <span className={sepCls} />
          <span className="flex items-center px-[16px] py-[10px] whitespace-nowrap text-white/[.7]">
            {note}
          </span>
        </>
      )}

      <span className={sepCls} />

      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center justify-center w-9 rounded-r-full hover:bg-white/[.16] transition-[background]"
        title="Clear selection"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
