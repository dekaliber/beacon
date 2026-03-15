import { useState, useRef, useEffect, useMemo } from "react";
import { X, Link2, Unlink, Star } from "lucide-react";
import { MultiSelectDropdown } from "@/components/MultiSelectDropdown";
import type { MultiSelectOption } from "@/components/MultiSelectDropdown";
import { bulkUpdateExpenses } from "@/api";
import type { Category, Tag } from "@/types";

// The action to show depends on which groups the selected expenses belong to:
//   "group"   → create a new group OR add ungrouped expenses to an existing group
//   "ungroup" → remove selected expenses from their respective groups
export type GroupAction = "group" | "ungroup";

interface BulkEditBarProps {
  ids: string[];
  categories: Category[];
  tags: Tag[];
  groupAction: GroupAction;
  setAsPrimaryTarget?: { expenseId: string; groupId: string } | null;
  onClear: () => void;
  onSuccess: () => void;
  onGroupAction: () => Promise<void>;
  onSetAsPrimary?: () => Promise<void>;
}

type ActivePopover = "description" | "category" | "tags" | null;

export function BulkEditBar({
  ids,
  categories,
  tags,
  groupAction,
  setAsPrimaryTarget,
  onClear,
  onSuccess,
  onGroupAction,
  onSetAsPrimary,
}: BulkEditBarProps) {
  const [active, setActive] = useState<ActivePopover>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [primaryLoading, setPrimaryLoading] = useState(false);

  // Per-popover field state
  const [description, setDescription] = useState("");
  // undefined = not yet chosen (Apply disabled); null = "No category"; string = category ID
  const [categoryId, setCategoryId] = useState<string | null | undefined>(undefined);
  const [categorySearch, setCategorySearch] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const barRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setActive(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const openPopover = (type: ActivePopover) => {
    if (active === type) { setActive(null); return; }
    setActive(type);
    setDescription("");
    setCategoryId(undefined);
    setCategorySearch("");
    setTagIds([]);
    setError(null);
    setLoading(false);
  };

  const handleApply = async (patch: Record<string, unknown>) => {
    setLoading(true);
    setError(null);
    try {
      await bulkUpdateExpenses(ids, patch);
      setActive(null);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setLoading(false);
    }
  };

  const handleGroupAction = async () => {
    setGroupLoading(true);
    try {
      await onGroupAction();
      onClear();
    } finally {
      setGroupLoading(false);
    }
  };

  const handleSetAsPrimary = async () => {
    if (!onSetAsPrimary) return;
    setPrimaryLoading(true);
    try {
      await onSetAsPrimary();
      onClear();
    } finally {
      setPrimaryLoading(false);
    }
  };

  // Category options
  const flatCategoryOptions = useMemo(() => {
    const parentCats = categories.filter((c) => !c.parentId);
    const childCats = categories.filter((c) => c.parentId);
    const opts: { id: string | null; label: string; parentLabel?: string }[] = [
      { id: null, label: "No category (clear)" },
    ];
    for (const parent of parentCats) {
      const children = childCats.filter((c) => c.parentId === parent.id);
      if (children.length === 0) {
        opts.push({ id: parent.id, label: parent.name });
      } else {
        for (const child of children) {
          opts.push({ id: child.id, label: child.name, parentLabel: parent.name });
        }
      }
    }
    return opts;
  }, [categories]);

  const filteredCategoryOptions = useMemo(() => {
    if (!categorySearch.trim()) return flatCategoryOptions;
    const terms = categorySearch.toLowerCase().split(/\s+/);
    return flatCategoryOptions.filter((o) => {
      if (o.id === null) return true;
      const text = (o.parentLabel ? o.parentLabel + " " : "") + o.label;
      const words = text.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    });
  }, [categorySearch, flatCategoryOptions]);

  const selectedCategoryLabel = useMemo(() => {
    if (categoryId === undefined) return null;
    if (categoryId === null) return "No category";
    const opt = flatCategoryOptions.find((o) => o.id === categoryId);
    return opt ? (opt.parentLabel ? `${opt.parentLabel} > ${opt.label}` : opt.label) : null;
  }, [categoryId, flatCategoryOptions]);

  // Tag options
  const tagOptions = useMemo<MultiSelectOption[]>(
    () => tags.map((t) => ({ id: t.id, label: t.name })),
    [tags],
  );

  const applyLabel = loading
    ? "Applying..."
    : `Apply to ${ids.length} transaction${ids.length !== 1 ? "s" : ""}`;

  const popoverCls =
    "absolute left-1/2 -translate-x-1/2 top-full mt-2 w-72 rounded-lg bg-background text-foreground border border-border shadow-xl p-3 z-50";

  const applyBtnCls =
    "mt-2 w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50 hover:opacity-90 transition-opacity";

  const sepCls = "w-px bg-primary-foreground/30 my-2 self-stretch shrink-0";

  const btnCls = (type: ActivePopover) =>
    `flex items-center gap-1.5 px-4 py-2.5 transition-colors whitespace-nowrap ${
      active === type ? "bg-white/20" : "hover:bg-white/10"
    }`;

  return (
    <div
      ref={barRef}
      className="fixed top-[60px] left-1/2 z-40 -translate-x-1/2 flex items-stretch rounded-full bg-primary text-primary-foreground shadow-lg text-sm font-medium select-none"
    >
      {/* Count */}
      <span className="flex items-center px-4 py-2.5 whitespace-nowrap">
        {ids.length} selected
      </span>

      <span className={sepCls} />

      {/* Edit Description */}
      <div className="relative">
        <button type="button" onClick={() => openPopover("description")} className={btnCls("description")}>
          Edit Description
        </button>
        {active === "description" && (
          <div className={popoverCls}>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && description.trim() && !loading) {
                  handleApply({ description: description.trim() });
                }
              }}
              placeholder="Enter new description..."
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
            <button
              type="button"
              disabled={!description.trim() || loading}
              onClick={() => handleApply({ description: description.trim() })}
              className={applyBtnCls}
            >
              {applyLabel}
            </button>
          </div>
        )}
      </div>

      <span className={sepCls} />

      {/* Edit Category */}
      <div className="relative">
        <button type="button" onClick={() => openPopover("category")} className={btnCls("category")}>
          Edit Category
        </button>
        {active === "category" && (
          <div className={popoverCls}>
            <input
              type="text"
              value={categorySearch}
              onChange={(e) => { setCategorySearch(e.target.value); setCategoryId(undefined); }}
              placeholder="Search categories..."
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            {selectedCategoryLabel && (
              <p className="mt-1 text-xs text-muted-foreground">
                Selected: <span className="font-medium text-foreground">{selectedCategoryLabel}</span>
              </p>
            )}
            <div className="mt-1 max-h-44 overflow-auto rounded-md border border-border">
              {filteredCategoryOptions.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
              ) : (
                filteredCategoryOptions.map((o) => (
                  <button
                    key={o.id ?? "__null__"}
                    type="button"
                    onMouseDown={() => { setCategoryId(o.id); setCategorySearch(""); }}
                    className={`block w-full px-3 py-1.5 text-left text-sm transition-colors ${
                      categoryId === o.id
                        ? "bg-primary/10 font-medium text-primary"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    {o.id === null ? (
                      <span className="italic text-muted-foreground">No category (clear)</span>
                    ) : (
                      <>
                        {o.parentLabel && (
                          <span className="text-muted-foreground">{o.parentLabel} &gt; </span>
                        )}
                        {o.label}
                      </>
                    )}
                  </button>
                ))
              )}
            </div>
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
            <button
              type="button"
              disabled={categoryId === undefined || loading}
              onClick={() => handleApply({ categoryId: categoryId ?? null })}
              className={applyBtnCls}
            >
              {applyLabel}
            </button>
          </div>
        )}
      </div>

      <span className={sepCls} />

      {/* Edit Tags */}
      <div className="relative">
        <button type="button" onClick={() => openPopover("tags")} className={btnCls("tags")}>
          Edit Tags
        </button>
        {active === "tags" && (
          <div className={popoverCls}>
            <MultiSelectDropdown
              options={tagOptions}
              selected={tagIds}
              onChange={setTagIds}
              placeholder="None (clears all tags)"
            />
            {tagIds.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">All tags will be removed from the selected expenses.</p>
            )}
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
            <button
              type="button"
              disabled={loading}
              onClick={() => handleApply({ tagIds, tagMode: "replace" })}
              className={applyBtnCls}
            >
              {applyLabel}
            </button>
          </div>
        )}
      </div>

      {/* Set as primary (only when a single non-primary grouped expense is selected) */}
      {setAsPrimaryTarget && (
        <>
          <span className={sepCls} />
          <button
            type="button"
            onClick={handleSetAsPrimary}
            disabled={primaryLoading}
            className="flex items-center gap-1.5 px-4 py-2.5 transition-colors whitespace-nowrap hover:bg-white/10 disabled:opacity-50"
          >
            <Star className="h-3.5 w-3.5" />
            {primaryLoading ? "Setting…" : "Set as primary"}
          </button>
        </>
      )}

      <span className={sepCls} />

      {/* Group / Ungroup */}
      <button
        type="button"
        onClick={handleGroupAction}
        disabled={groupLoading}
        className="flex items-center gap-1.5 px-4 py-2.5 transition-colors whitespace-nowrap hover:bg-white/10 disabled:opacity-50"
        title={groupAction === "group" ? "Group selected transactions" : "Remove from group"}
      >
        {groupAction === "group" ? (
          <><Link2 className="h-3.5 w-3.5" />{groupLoading ? "Grouping…" : "Group Transactions"}</>
        ) : (
          <><Unlink className="h-3.5 w-3.5" />{groupLoading ? "Ungrouping…" : "Remove from Group"}</>
        )}
      </button>

      <span className={sepCls} />

      {/* Clear selection */}
      <button
        type="button"
        onClick={onClear}
        className="flex items-center px-3 py-2.5 hover:bg-white/10 rounded-r-full transition-colors"
        title="Clear selection"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
