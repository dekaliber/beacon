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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
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
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
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
        onClick={() => {
          if (!open && ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(window.innerHeight - rect.bottom < 240);
          }
          setOpen(!open);
        }}
        className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm ${
          isActive ? "border-primary text-primary" : "border-border text-foreground"
        }`}
      >
        <span className="max-w-[140px] truncate">{buttonLabel}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-50" />
      </button>

      {open && (
        <div className={`absolute left-0 z-50 min-w-[200px] rounded-md border border-border bg-background shadow-lg ${flipUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
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
                    <p className="px-3 pt-2 pb-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </p>
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
      )}
    </div>
  );
}
