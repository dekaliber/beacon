import { cn } from "@/lib/utils";
import type {
  ElementType,
  HTMLAttributes,
  ThHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
} from "react";

type WithAs = { as?: ElementType; className?: string; children?: ReactNode };

/** Mono uppercase eyebrow above a card or section heading.
 *  @example <Eyebrow>Spent this month</Eyebrow>
 *  @example <Eyebrow as="h3" className="mb-2">Portfolio</Eyebrow> */
export function Eyebrow({
  as: Tag = "p",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("tp-eyebrow", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Stronger variant of Eyebrow — ink-2 instead of ink-3.
 *  @example <EyebrowLoud>Year-to-date</EyebrowLoud> */
export function EyebrowLoud({
  as: Tag = "p",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("tp-eyebrow-loud", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Table <th> with TableHeader recipe styling.
 *  @example <ColumnHeader className="text-right w-24">Amount</ColumnHeader> */
export function ColumnHeader({
  className,
  children,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("tp-table-header", className)}
      {...props}
    >
      {children}
    </th>
  );
}

/** Numeric value in Geist Mono + tabular figures — for amounts in rows/tables.
 *  Only sets the typeface and tnum; caller controls size, weight, and color.
 *  For a complete row-amount recipe use .tp-numeric directly.
 *  @example <StatValue className="text-13 font-medium text-ink">{fmtAmount(amount)}</StatValue> */
export function StatValue({
  as: Tag = "span",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("font-mono tabular-nums", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Display-level numeric value in Hanken Grotesk + tabular figures.
 *  Only sets the typeface and tnum; caller controls size and weight.
 *  Add a tp-* recipe class (tp-kpi, tp-stat, etc.) for a complete treatment.
 *  @example <DisplayStat className="tp-kpi">{formatCurrency(total)}</DisplayStat>
 *  @example <DisplayStat className="tp-stat text-up">{budgetPct}%</DisplayStat> */
export function DisplayStat({
  as: Tag = "span",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("font-display tabular-nums", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Supporting context text below a stat or heading — no uppercase.
 *  @example <Caption>of {formatCurrency(budget)} budget</Caption>
 *  @example <Caption as="span">{fmtDate(date)}</Caption> */
export function Caption({
  as: Tag = "p",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("tp-caption", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Tiny mono label riding beside or under a value — pace labels, timestamps.
 *  @example <Fineprint>of $3,900 budget</Fineprint> */
export function Fineprint({
  as: Tag = "span",
  className,
  children,
  ...props
}: WithAs & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn("tp-fineprint", className)}
      {...(props as object)}
    >
      {children}
    </Tag>
  );
}

/** Form field <label> with eyebrow-style label treatment.
 *  @example <FieldLabel htmlFor="amount">Amount</FieldLabel> */
export function FieldLabel({
  className,
  children,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("tp-eyebrow", className)}
      {...props}
    >
      {children}
    </label>
  );
}

/** @deprecated Use <Eyebrow> instead */
export const SectionLabel = Eyebrow;
