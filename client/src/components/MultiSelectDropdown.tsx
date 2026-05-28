import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { SectionLabel } from "@/components/Typography";

export interface MultiSelectOption {
  id: string;
  label: string;
  groupKey?: string;
}

export interface MultiSelectGroup {
  key: string;
  label: string;
}

interface MultiSelectDropdownProps {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder: string;
  groups?: MultiSelectGroup[];
  searchable?: boolean;
}

export function MultiSelectDropdown({
  options,
  selected,
  onChange,
  placeholder,
  groups,
  searchable,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [search, setSearch] = useState("");
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });

  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click — panel is portalled to <body> so it's a separate
  // DOM subtree from triggerRef; we must check both refs.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        (!panelRef.current || !panelRef.current.contains(target))
      ) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  const visibleOptions = searchable && search.trim()
    ? options.filter((o) => {
        const terms = search.toLowerCase().split(/\s+/);
        const words = o.label.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^a-z]+/, ""));
        return terms.every((t) => words.some((w) => w.startsWith(t)));
      })
    : options;

  const selectAll = () => {
    const visibleIds = visibleOptions.map((o) => o.id);
    onChange([...new Set([...selected, ...visibleIds])]);
  };
  const deselectAll = () => {
    const visibleIds = new Set(visibleOptions.map((o) => o.id));
    onChange(selected.filter((id) => !visibleIds.has(id)));
  };

  const buttonLabel =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? (options.find((o) => o.id === selected[0])?.label ?? "1 selected")
        : `${selected.length} selected`;

  const isActive = selected.length > 0;

  const handleOpen = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const flip = window.innerHeight - rect.bottom < 240;
      setFlipUp(flip);
      setPanelPos({
        top: flip ? rect.top - 4 : rect.bottom + 4,
        left: rect.left,
      });
    }
    setOpen((v) => !v);
  };

  const renderOption = (opt: MultiSelectOption) => (
    <button
      key={opt.id}
      type="button"
      onClick={() => toggle(opt.id)}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/50"
    >
      <span
        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
          selected.includes(opt.id)
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border"
        }`}
      >
        {selected.includes(opt.id) && <Check className="h-3 w-3" />}
      </span>
      {opt.label}
    </button>
  );

  // The panel is portalled to document.body so that backdrop-filter on ancestor
  // Cards cannot act as a containing block or stacking context for the panel.
  // position:fixed + viewport-relative coords from getBoundingClientRect() then
  // work correctly regardless of what's in the component tree above this.
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
      className="min-w-[200px] rounded-md border border-border bg-background shadow-lg"
    >
      <div className="flex gap-3 border-b border-border px-3 py-1.5">
        <button
          type="button"
          onClick={selectAll}
          className="text-xs text-primary hover:underline"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={deselectAll}
          className="tp-caption hover:underline"
        >
          Deselect all
        </button>
      </div>
      {searchable && (
        <div className="border-b border-border p-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full rounded border border-border px-2 py-1 text-sm focus:outline-none"
            autoFocus
          />
        </div>
      )}
      <div className="max-h-52 overflow-auto">
        {groups ? (
          groups.map((group) => {
            const groupOptions = visibleOptions.filter((o) => o.groupKey === group.key);
            if (groupOptions.length === 0) return null;
            return (
              <div key={group.key}>
                <SectionLabel className="px-3 pt-2 pb-0.5">{group.label}</SectionLabel>
                {groupOptions.map(renderOption)}
              </div>
            );
          })
        ) : visibleOptions.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No categories found</p>
        ) : (
          visibleOptions.map(renderOption)
        )}
      </div>
    </div>
  ) : null;

  return (
    <div ref={triggerRef} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className={`relative flex items-center rounded-[6px] border pl-2 pr-6 py-2 text-[13px] bg-white/[.78] [box-shadow:var(--shadow-input)] transition-[border-color] duration-[120ms] outline-none ${
          isActive
            ? "border-primary text-primary hover:border-primary"
            : "border-[var(--color-border)] text-foreground hover:border-[color-mix(in_oklab,var(--color-primary)_30%,oklch(0.16_0.020_265_/_0.12))]"
        }`}
      >
        <span className="max-w-[140px] truncate">{buttonLabel}</span>
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
      </button>

      {createPortal(panel, document.body)}
    </div>
  );
}
