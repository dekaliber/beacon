import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export function getScrollParentBottom(el: Element): number {
  let parent = el.parentElement;
  while (parent && parent !== document.documentElement) {
    const { overflow, overflowY } = window.getComputedStyle(parent);
    if (/(auto|scroll|hidden)/.test(overflow) || /(auto|scroll|hidden)/.test(overflowY)) {
      return parent.getBoundingClientRect().bottom;
    }
    parent = parent.parentElement;
  }
  return window.innerHeight;
}

export function ItemTypeahead({
  name, defaultValue, items, placeholder, triggerRef: externalTriggerRef, onTabFromSearch, required, error, onSelect, onChange,
}: {
  name: string;
  defaultValue?: string;
  items: { id: string; name: string; isHidden?: boolean }[];
  placeholder?: string;
  required?: boolean;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  onTabFromSearch?: () => void;
  error?: boolean;
  onSelect?: () => void;
  onChange?: (id: string) => void;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const clickingRef = useRef(false);
  const justSelectedRef = useRef(false);

  useEffect(() => { setValue(defaultValue ?? ""); }, [defaultValue]);

  const sorted = useMemo(() =>
    [...items].sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  );

  const filtered = useMemo(() => {
    const visible = sorted.filter((item) => !item.isHidden);
    if (!search.trim()) return visible;
    const terms = search.toLowerCase().split(/\s+/);
    return visible.filter((item) => {
      const words = item.name.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    });
  }, [search, sorted]);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        ref.current && !ref.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close when the page scrolls (but not when scrolling inside the dropdown list)
  useEffect(() => {
    if (!open) return;
    const handleScroll = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const handleResize = () => setOpen(false);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [open]);

  const selectedLabel = useMemo(() => sorted.find((item) => item.id === value)?.name ?? "", [value, sorted]);

  const openDropdown = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setAnchorRect(rect);
      setFlipUp(window.innerHeight - rect.bottom < 240);
    }
    setOpen(true);
  };

  const selectItem = (id: string) => {
    setValue(id);
    setOpen(false);
    setSearch("");
    justSelectedRef.current = true;
    onChange?.(id);
    onSelect?.();
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      setOpen(false);
      setSearch("");
      onTabFromSearch?.();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); selectItem(filtered[focusIdx].id); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <input type="hidden" name={name} value={value} />
      {required && !value && <input type="text" required value="" style={{ opacity: 0, position: "absolute", pointerEvents: "none", width: 0, height: 0 }} tabIndex={-1} onChange={() => {}} />}
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={() => { clickingRef.current = true; }}
        onFocus={(e) => {
          if (justSelectedRef.current || clickingRef.current) {
            justSelectedRef.current = false;
            clickingRef.current = false;
            return;
          }
          // Only auto-open when tabbing forward (related target precedes this button in DOM)
          const related = e.relatedTarget as Element | null;
          if (related && !(related.compareDocumentPosition(e.currentTarget) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
          openDropdown();
        }}
        onClick={() => {
          if (!open) {
            openDropdown();
          } else {
            setOpen(false);
          }
        }}
        className={`w-full relative rounded-md border bg-[rgba(255,255,255,0.78)] shadow-[var(--shadow-input)] px-3 py-2 pr-7 text-left text-13 text-foreground hover:border-primary/30 focus:outline-none transition-[border-color] duration-[120ms] ${error ? "border-down focus:border-down" : "border-border focus:border-primary/30"}`}
      >
        {selectedLabel || <span className="text-muted-foreground">{placeholder ?? "Select..."}</span>}
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
      </button>
      {open && anchorRect && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            left: anchorRect.left,
            width: anchorRect.width,
            zIndex: 200,
            ...(flipUp
              ? { bottom: window.innerHeight - anchorRect.top + 4 }
              : { top: anchorRect.bottom + 4 }),
          }}
          className="rounded-md border border-border bg-white shadow-lg"
        >
          <div className="border-b border-border p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type to filter..."
              className="w-full rounded border border-border px-2 py-1 text-13 focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-13 text-muted-foreground">No matches</p>
            ) : (
              filtered.map((item, i) => (
                <button
                  key={item.id}
                  type="button"
                  tabIndex={-1}
                  className={`block w-full px-3 py-1.5 text-left text-13 ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted"}`}
                  onMouseDown={() => selectItem(item.id)}
                >
                  {item.name}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
