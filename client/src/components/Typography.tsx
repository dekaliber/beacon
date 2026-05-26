import { cn } from "@/lib/utils";
import type {
  ElementType,
  HTMLAttributes,
  ThHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
} from "react";

type WithAs = { as?: ElementType; className?: string; children?: ReactNode };

/** Uppercase tracked small label for card/section/panel headers.
 *  @example <SectionLabel>Net Worth</SectionLabel>
 *  @example <SectionLabel as="h3" className="mb-2">Portfolio</SectionLabel> */
export function SectionLabel({
  as: Tag = "p",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn(
        "text-xs font-medium text-muted-foreground uppercase tracking-[1px] font-label",
        className,
      )}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Table <th> with the standard column-header label styling.
 *  @example <ColumnHeader className="text-right w-24">Amount</ColumnHeader> */
export function ColumnHeader({
  className,
  children,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "text-[10px] font-medium text-muted-foreground uppercase tracking-[1px] font-label",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

/** Wraps a small/inline numeric value in Geist Mono + tabular figures.
 *  Use for text-sm/text-xs amounts in tables, lists, and inline context.
 *  Caller supplies size and weight via className.
 *  @example <StatValue className="font-medium text-foreground">{amount}</StatValue>
 *  @example <StatValue className="text-xs font-semibold">{fmtAmount(t.amount)}</StatValue> */
export function StatValue({
  as: Tag = "span",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("tabular-nums font-label", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Wraps a display-level numeric value in Hanken Grotesk + tabular figures.
 *  Use sparingly for headline numbers at text-base or larger.
 *  @example <DisplayStat as="p" className="text-3xl font-bold">{formatCurrency(total)}</DisplayStat>
 *  @example <DisplayStat as="p" className="text-2xl font-bold">{budgetPct}%</DisplayStat> */
export function DisplayStat({
  as: Tag = "span",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("tabular-nums font-numeral", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Supporting context text below a stat or heading (no uppercase).
 *  @example <Caption>of {formatCurrency(budget)} budget</Caption>
 *  @example <Caption as="span" className="shrink-0">{fmtDate(date)}</Caption> */
export function Caption({
  as: Tag = "p",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("text-xs text-muted-foreground font-label", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Form field <label> with standard label styling.
 *  @example <FieldLabel htmlFor="amount">Amount</FieldLabel> */
export function FieldLabel({
  className,
  children,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "text-xs font-medium text-muted-foreground uppercase tracking-[1px] font-label",
        className,
      )}
      {...props}
    >
      {children}
    </label>
  );
}
