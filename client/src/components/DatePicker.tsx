import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addDays,
  addMonths,
  format,
  isSameDay,
  isSameMonth,
  setMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn, formatDate, localToday } from "@/lib/utils";

interface DatePickerProps {
  /** Controlled value as YYYY-MM-DD (same wire format as <input type="date">). */
  value: string;
  /** Receives the bare YYYY-MM-DD string (or "" when cleared) — NOT an event. */
  onChange: (value: string) => void;
  /** YYYY-MM-DD — days before this are disabled / rejected. */
  min?: string;
  /** YYYY-MM-DD — days after this are disabled / rejected. */
  max?: string;
  /** Applied to the trigger wrapper (width, compact sizing, etc.). */
  className?: string;
  id?: string;
  /** When set, renders a hidden input so uncontrolled <form> FromData still works. */
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Open the calendar immediately on mount (for click-to-edit table cells). */
  autoOpen?: boolean;
  /** Fired when focus fully leaves the field and its popover (edit session ended). */
  onDismiss?: () => void;
  /**
   * Defer typed/pasted edits until the user confirms with Enter (or an explicit
   * calendar pick). Blur and Escape discard the edit without committing. Used by
   * inline table cells where onChange persists immediately.
   */
  confirmOnEnter?: boolean;
  /** Hide the trailing calendar icon (e.g. inline cells where it auto-opens). */
  hideIcon?: boolean;
  /**
   * Compact display: format as m/d/yy and shrink the field to its content
   * width (instead of filling its container). Works with any variant.
   */
  compact?: boolean;
  required?: boolean;
  /** Render a red border for externally-managed validation errors. */
  invalid?: boolean;
  /**
   * "input"  — bordered field (default), for forms and filters.
   * "ghost"  — borderless/transparent, for inline table cells.
   */
  variant?: "input" | "ghost";
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** Parse a YYYY-MM-DD string to a local-midnight Date, or null if empty/invalid. */
function parseYMD(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a Date to YYYY-MM-DD using local date parts (no timezone shift). */
function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * YYYY-MM-DD → display string for the typeable text field.
 * compact = M/D/YY (no leading zeros, 2-digit year) for tight inline cells;
 * otherwise MM/DD/YYYY for standalone fields.
 */
function ymdToDisplay(ymd: string, compact: boolean): string {
  const d = parseYMD(ymd);
  if (!d) return "";
  if (compact) {
    return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
  }
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Light input mask: keep digits, regroup as MM/DD/YYYY as the user types. */
function maskDate(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join("/");
}

/**
 * Parse a typed/pasted date to YYYY-MM-DD, or null if not a real date.
 * Accepts M/D/YY, M/D/YYYY, and MM/DD/YYYY. A 2-digit year maps to 2000–2099.
 */
function parseDisplay(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  // Reject overflow (e.g. 02/31) — JS rolls it over, so verify round-trip.
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return toYMD(d);
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  className,
  id,
  name,
  placeholder,
  disabled,
  autoFocus,
  autoOpen,
  onDismiss,
  confirmOnEnter,
  hideIcon,
  compact,
  required,
  invalid,
  variant = "input",
}: DatePickerProps) {
  const ghost = variant === "ghost";
  // Ghost cells are always compact; `compact` enables it for other variants too.
  const compactFmt = compact || ghost;
  const fitContent = compact || ghost; // shrink to content rather than fill container
  const effectivePlaceholder = placeholder ?? (compactFmt ? "m/d/yy" : "mm/dd/yyyy");

  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });
  const [mode, setMode] = useState<"days" | "months">("days");
  const [viewDate, setViewDate] = useState(() => parseYMD(value) ?? new Date());
  const [text, setText] = useState(() => ymdToDisplay(value, compactFmt));
  const [focused, setFocused] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => parseYMD(value), [value]);
  const todayYMD = localToday();

  // Keep the text field in sync with external value changes — but never while the
  // user is mid-edit, or we'd fight their cursor.
  useEffect(() => {
    if (!focused) setText(ymdToDisplay(value, compactFmt));
  }, [value, focused, compactFmt]);

  // Close on outside click — panel is portalled to <body> (separate subtree), so
  // check both refs. Mirrors MultiSelectDropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        wrapRef.current && !wrapRef.current.contains(t) &&
        (!panelRef.current || !panelRef.current.contains(t))
      ) {
        setOpen(false);
        onDismiss?.();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        onDismiss?.();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const rangeMessage = (ymd: string): string | null => {
    if (min && ymd < min) return `Must be on or after ${formatDate(min)}`;
    if (max && ymd > max) return `Must be on or before ${formatDate(max)}`;
    return null;
  };
  const isDisabledDay = (ymd: string) => rangeMessage(ymd) !== null;

  const openCalendar = () => {
    if (disabled || open) return;
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      const flip = window.innerHeight - rect.bottom < 340;
      setFlipUp(flip);
      setPanelPos({ top: flip ? rect.top - 4 : rect.bottom + 4, left: rect.left });
    }
    setMode("days");
    setViewDate(parseYMD(value) ?? new Date());
    setOpen(true);
  };

  // Open immediately when used as a click-to-edit cell.
  useEffect(() => {
    if (autoOpen) openCalendar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitDate = (ymd: string) => {
    const msg = rangeMessage(ymd);
    if (msg) {
      setRangeError(msg);
      return;
    }
    setRangeError(null);
    onChange(ymd);
    setText(ymdToDisplay(ymd, compactFmt));
  };

  const pickFromCalendar = (d: Date) => {
    commitDate(toYMD(d));
    setOpen(false);
    onDismiss?.();
  };

  // ── Text-field handlers ──────────────────────────────────────────────
  const handleTextChange = (raw: string) => {
    // Compact (ghost) cells allow free m/d/yy typing; standalone fields auto-mask.
    const next = compactFmt ? raw : maskDate(raw);
    setText(next);
    if (next.trim() === "") {
      setRangeError(null);
      if (!confirmOnEnter) onChange("");
      return;
    }
    const ymd = parseDisplay(next);
    if (ymd) {
      const msg = rangeMessage(ymd);
      setRangeError(msg);
      // In confirm mode, hold the edit until Enter — don't commit on keystroke.
      if (!msg && !confirmOnEnter) onChange(ymd);
    } else {
      // Partial/incomplete entry — don't nag yet.
      setRangeError(null);
    }
  };

  const handleBlur = () => {
    setFocused(false);
    if (confirmOnEnter) {
      // Discard the unconfirmed edit and restore the committed value.
      setText(ymdToDisplay(value, compactFmt));
      setRangeError(null);
      return;
    }
    const trimmed = text.trim();
    if (trimmed === "") {
      setRangeError(null);
      onChange("");
      return;
    }
    const ymd = parseDisplay(trimmed);
    if (!ymd) {
      setRangeError("Invalid date");
      return;
    }
    const msg = rangeMessage(ymd);
    if (msg) {
      setRangeError(msg);
      return;
    }
    setRangeError(null);
    onChange(ymd);
    setText(ymdToDisplay(ymd, compactFmt));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").trim();
    // Accept m/d/yy, m/d/yyyy, mm/dd/yyyy on paste regardless of variant.
    const ymd = parseDisplay(pasted);
    if (ymd) {
      e.preventDefault();
      const msg = rangeMessage(ymd);
      setRangeError(msg);
      setText(ymdToDisplay(ymd, compactFmt));
      // In confirm mode, paste only fills the field — Enter commits it.
      if (!msg && !confirmOnEnter) onChange(ymd);
    }
  };

  // Confirm/cancel the buffered edit in confirm mode (inline cells).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!confirmOnEnter) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed === "") {
        onDismiss?.();
        return;
      }
      const ymd = parseDisplay(trimmed);
      if (!ymd) {
        setRangeError("Invalid date");
        return;
      }
      const msg = rangeMessage(ymd);
      if (msg) {
        setRangeError(msg);
        return;
      }
      setRangeError(null);
      onChange(ymd);
      setOpen(false);
      onDismiss?.();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setText(ymdToDisplay(value, compactFmt));
      setRangeError(null);
      setOpen(false);
      onDismiss?.();
    }
  };

  // ── Calendar grid: 6 weeks (42 cells) from the Sunday on/before the 1st ──
  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(viewDate), { weekStartsOn: 0 });
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [viewDate]);

  const panel = open ? (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        top: panelPos.top,
        left: panelPos.left,
        transform: flipUp ? "translateY(-100%)" : undefined,
        zIndex: 9999,
      }}
      className="w-[256px] rounded-md border border-border bg-background p-3 shadow-lg"
    >
      {mode === "days" ? (
        <>
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMode("months")}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-15 font-semibold text-ink hover:bg-muted/50"
            >
              {format(viewDate, "MMMM yyyy")}
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setViewDate((d) => addMonths(d, -1))}
                className="rounded p-1 text-ink-2 hover:bg-muted/50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setViewDate((d) => addMonths(d, 1))}
                className="rounded p-1 text-ink-2 hover:bg-muted/50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mb-1 grid grid-cols-7">
            {WEEKDAYS.map((w, i) => (
              <div key={i} className="tp-caption text-center text-ink-4">
                {w}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-y-0.5">
            {days.map((d) => {
              const ymd = toYMD(d);
              const inMonth = isSameMonth(d, viewDate);
              const isSelected = selected ? isSameDay(d, selected) : false;
              const isToday = ymd === todayYMD;
              const dayDisabled = isDisabledDay(ymd);
              return (
                <button
                  key={ymd}
                  type="button"
                  disabled={dayDisabled}
                  onClick={() => pickFromCalendar(d)}
                  className={cn(
                    "mx-auto flex h-8 w-8 items-center justify-center rounded-md text-13 tabular-nums transition-colors",
                    isSelected
                      ? "bg-primary font-medium text-primary-foreground"
                      : dayDisabled
                        ? "cursor-not-allowed text-ink-4 opacity-40"
                        : inMonth
                          ? "text-ink hover:bg-muted/50"
                          : "text-ink-4 hover:bg-muted/50",
                    isToday && !isSelected && "ring-1 ring-inset ring-primary/40",
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
            <button
              type="button"
              onClick={() => {
                setRangeError(null);
                onChange("");
                setText("");
                setOpen(false);
                onDismiss?.();
              }}
              className="text-13 text-primary hover:underline"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                if (!isDisabledDay(todayYMD)) {
                  commitDate(todayYMD);
                  setOpen(false);
                  onDismiss?.();
                } else {
                  setViewDate(parseYMD(todayYMD)!);
                }
              }}
              className="text-13 text-primary hover:underline"
            >
              Today
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous year"
              onClick={() => setViewDate((d) => addMonths(d, -12))}
              className="rounded p-1 text-ink-2 hover:bg-muted/50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-15 font-semibold text-ink tabular-nums">
              {format(viewDate, "yyyy")}
            </span>
            <button
              type="button"
              aria-label="Next year"
              onClick={() => setViewDate((d) => addMonths(d, 12))}
              className="rounded p-1 text-ink-2 hover:bg-muted/50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {Array.from({ length: 12 }, (_, m) => {
              const isCur = m === viewDate.getMonth();
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setViewDate((d) => setMonth(d, m));
                    setMode("days");
                  }}
                  className={cn(
                    "rounded-md py-2 text-13 transition-colors",
                    isCur
                      ? "bg-primary font-medium text-primary-foreground"
                      : "text-ink hover:bg-muted/50",
                  )}
                >
                  {format(setMonth(viewDate, m), "MMM")}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  ) : null;

  const showError = invalid || rangeError !== null;

  return (
    <div ref={wrapRef} className={cn(fitContent ? "inline-flex flex-col" : "flex flex-col", className)}>
      <div
        className={cn(
          "group relative flex items-center",
          ghost
            ? "gap-1"
            : cn(
                "rounded-[6px] border bg-white/[.78] [box-shadow:var(--shadow-input)] transition-[border-color] duration-[120ms]",
                showError
                  ? "border-down"
                  : "border-border hover:border-[color-mix(in_oklab,var(--color-primary)_30%,oklch(0.16_0.020_265_/_0.12))] focus-within:border-primary",
              ),
          disabled && "cursor-not-allowed opacity-55",
        )}
      >
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          autoFocus={autoFocus}
          required={required}
          disabled={disabled}
          size={ghost ? 8 : compact ? 5 : undefined}
          placeholder={effectivePlaceholder}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            handleBlur();
            if (onDismiss) {
              const next = e.relatedTarget as Node | null;
              const intoField =
                !!next &&
                ((panelRef.current?.contains(next) ?? false) ||
                  (wrapRef.current?.contains(next) ?? false));
              if (!intoField) onDismiss();
            }
          }}
          onPaste={handlePaste}
          className={cn(
            "datepicker-field text-13 text-foreground outline-none placeholder:text-ink-4 disabled:cursor-not-allowed",
            ghost
              ? "w-auto px-0"
              : cn(fitContent ? "w-auto" : "w-full", "py-2 pl-2", hideIcon ? "pr-2" : "pr-1"),
          )}
        />
        {!hideIcon && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Open calendar"
            disabled={disabled}
            onClick={() => (open ? setOpen(false) : openCalendar())}
            className={cn(
              "flex flex-shrink-0 items-center text-ink-3 transition-opacity hover:text-primary",
              ghost
                ? "pr-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                : "pr-2",
            )}
          >
            <Calendar className="h-3.5 w-3.5 opacity-60" />
          </button>
        )}
        {name && <input type="hidden" name={name} value={value} />}
      </div>
      {rangeError && <p className="mt-1 text-xs text-down">{rangeError}</p>}
      {createPortal(panel, document.body)}
    </div>
  );
}
