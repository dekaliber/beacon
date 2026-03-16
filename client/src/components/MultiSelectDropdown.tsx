import { useRef, useState, useEffect } from "react";
import { Check, ChevronDown } from "lucide-react";

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
}

export function MultiSelectDropdown({
  options,
  selected,
  onChange,
  placeholder,
  groups,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  const selectAll = () => onChange(options.map((o) => o.id));
  const deselectAll = () => onChange([]);

  const buttonLabel =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? (options.find((o) => o.id === selected[0])?.label ?? "1 selected")
        : `${selected.length} selected`;

  const isActive = selected.length > 0;

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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm ${
          isActive ? "border-primary text-primary" : "border-border text-foreground"
        }`}
      >
        <span className="max-w-[140px] truncate">{buttonLabel}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[200px] rounded-md border border-border bg-background shadow-lg">
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
              className="text-xs text-muted-foreground hover:underline"
            >
              Deselect all
            </button>
          </div>
          <div className="max-h-52 overflow-auto">
            {groups ? (
              groups.map((group) => {
                const groupOptions = options.filter((o) => o.groupKey === group.key);
                if (groupOptions.length === 0) return null;
                return (
                  <div key={group.key}>
                    <p className="px-3 pt-2 pb-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </p>
                    {groupOptions.map(renderOption)}
                  </div>
                );
              })
            ) : (
              options.map(renderOption)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
