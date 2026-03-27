import { useState, useRef, useEffect, useMemo } from "react";
import { X, Link2, Unlink, Star, Check, Trash2 } from "lucide-react";
import { bulkUpdateExpenses, bulkDeleteExpenses } from "@/api";
import type { Category, Tag } from "@/types";

// The action to show depends on which groups the selected expenses belong to:
//   "group"   → create a new group OR add ungrouped expenses to an existing group
//   "ungroup" → remove selected expenses from their respective groups
export type GroupAction = "group" | "ungroup";

interface BulkEditBarProps {
  ids: string[];
  categories: Category[];
  tags?: Tag[];
  initialTagIds?: string[];
  groupAction?: GroupAction;
  setAsPrimaryTarget?: { expenseId: string; groupId: string } | null;
  onClear: () => void;
  onSuccess: () => void;
  onGroupAction?: () => Promise<void>;
  onSetAsPrimary?: () => Promise<void>;
  onCreateTag?: (name: string) => Promise<Tag>;
  /** Label for the free-text edit button (default: "Edit Description") */
  textFieldLabel?: string;
  /** Patch key for the free-text field (default: "description") */
  textFieldKey?: string;
  /** Override the bulk-update API call (default: bulkUpdateExpenses) */
  onApply?: (patch: Record<string, unknown>) => Promise<void>;
  /** Override the bulk-delete API call (default: bulkDeleteExpenses) */
  onBulkDelete?: () => Promise<void>;
  /** When true, shows the Edit Tax Status popover */
  showTaxStatus?: boolean;
  /** When true, the Delete button is shown but disabled */
  deleteDisabled?: boolean;
  /** Tooltip shown on the disabled Delete button */
  deleteDisabledTitle?: string;
}

type ActivePopover = "description" | "category" | "taxStatus" | "tags" | null;

const TAX_STATUS_OPTIONS: { value: string; label: string; className: string }[] = [
  { value: "", label: "Not specified (clear)", className: "" },
  { value: "CAPITAL_GAIN", label: "Capital Gain", className: "bg-blue-100 text-blue-700" },
  { value: "ORDINARY", label: "Ordinary", className: "bg-slate-100 text-slate-600" },
  { value: "QUALIFIED", label: "Qualified", className: "bg-emerald-100 text-emerald-700" },
  { value: "RETURN_OF_CAPITAL", label: "Return of Capital", className: "bg-amber-100 text-amber-700" },
  { value: "TAX_EXEMPT", label: "Tax-Exempt", className: "bg-teal-100 text-teal-700" },
];

export function BulkEditBar({
  ids,
  categories,
  tags,
  initialTagIds,
  groupAction,
  setAsPrimaryTarget,
  onClear,
  onSuccess,
  onGroupAction,
  onSetAsPrimary,
  onCreateTag,
  textFieldLabel = "Edit Description",
  textFieldKey = "description",
  onApply,
  onBulkDelete,
  showTaxStatus = false,
  deleteDisabled = false,
  deleteDisabledTitle,
}: BulkEditBarProps) {
  const [active, setActive] = useState<ActivePopover>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [primaryLoading, setPrimaryLoading] = useState(false);

  // Per-popover field state
  const [description, setDescription] = useState("");
  // undefined = not yet chosen (Apply disabled); null = "No category"; string = category ID
  const [categoryId, setCategoryId] = useState<string | null | undefined>(undefined);
  // undefined = not yet chosen; null/"" = clear; string = TaxClassification value
  const [taxStatusValue, setTaxStatusValue] = useState<string | undefined>(undefined);
  const [categorySearch, setCategorySearch] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagSearch, setTagSearch] = useState("");
  const [tagCreating, setTagCreating] = useState(false);
  const [localTags, setLocalTags] = useState<Tag[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

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
    setTaxStatusValue(undefined);
    setTagIds(type === "tags" ? (initialTagIds ?? []) : []);
    setTagSearch("");
    setTagCreating(false);
    setLocalTags([]);
    setError(null);
    setLoading(false);
  };

  const handleApply = async (patch: Record<string, unknown>) => {
    setLoading(true);
    setError(null);
    try {
      await (onApply ? onApply(patch) : bulkUpdateExpenses(ids, patch));
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

  // Tag options (merge backend tags with any locally-created ones)
  const allTags = useMemo(() => {
    const base = tags ?? [];
    const ids = new Set(base.map((t) => t.id));
    return [...base, ...localTags.filter((t) => !ids.has(t.id))].sort((a, b) => a.name.localeCompare(b.name));
  }, [tags, localTags]);

  const filteredTags = useMemo(() => {
    if (!tagSearch.trim()) return allTags;
    const terms = tagSearch.toLowerCase().split(/\s+/);
    return allTags.filter((t) => {
      const words = t.name.toLowerCase().split(/\s+/);
      return terms.every((term) => words.some((w) => w.startsWith(term)));
    });
  }, [tagSearch, allTags]);

  const showTagCreate = !!tagSearch.trim() && filteredTags.length === 0 && !!onCreateTag;

  const handleCreateTag = async () => {
    const name = tagSearch.trim();
    if (!name || tagCreating || !onCreateTag) return;
    setTagCreating(true);
    try {
      const newTag = await onCreateTag(name);
      setLocalTags((prev) => [...prev, newTag]);
      setTagIds((prev) => [...prev, newTag.id]);
      setTagSearch("");
    } finally {
      setTagCreating(false);
    }
  };

  const toggleTagId = (id: string) => {
    setTagIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const handleDelete = async () => {
    setDeleteLoading(true);
    try {
      await (onBulkDelete ? onBulkDelete() : bulkDeleteExpenses(ids));
      setShowDeleteConfirm(false);
      onSuccess();
    } finally {
      setDeleteLoading(false);
    }
  };

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
    <>
    <div
      ref={barRef}
      className="fixed top-[60px] left-1/2 z-40 -translate-x-1/2 flex items-stretch rounded-full bg-primary text-primary-foreground shadow-lg text-sm font-medium select-none"
    >
      {/* Count */}
      <span className="flex items-center px-4 py-2.5 whitespace-nowrap">
        {ids.length} selected
      </span>

      <span className={sepCls} />

      {/* Edit text field (Description / Source / etc.) */}
      <div className="relative">
        <button type="button" onClick={() => openPopover("description")} className={btnCls("description")}>
          {textFieldLabel}
        </button>
        {active === "description" && (
          <div className={popoverCls}>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && description.trim() && !loading) {
                  handleApply({ [textFieldKey]: description.trim() });
                }
              }}
              placeholder={`Enter new ${textFieldLabel.replace("Edit ", "").toLowerCase()}...`}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
            <button
              type="button"
              disabled={!description.trim() || loading}
              onClick={() => handleApply({ [textFieldKey]: description.trim() })}
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

      {showTaxStatus && <span className={sepCls} />}

      {/* Edit Tax Status */}
      {showTaxStatus && (
        <div className="relative">
          <button type="button" onClick={() => openPopover("taxStatus")} className={btnCls("taxStatus")}>
            Edit Tax Status
          </button>
          {active === "taxStatus" && (
            <div className={popoverCls}>
              <div className="rounded-md border border-border overflow-hidden">
                {TAX_STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onMouseDown={() => setTaxStatusValue(opt.value)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      taxStatusValue === opt.value ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted/50"
                    }`}
                  >
                    {opt.value
                      ? <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${opt.className}`}>{opt.label}</span>
                      : <span className="italic text-muted-foreground">{opt.label}</span>
                    }
                  </button>
                ))}
              </div>
              {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
              <button
                type="button"
                disabled={taxStatusValue === undefined || loading}
                onClick={() => handleApply({ taxClassification: taxStatusValue || null })}
                className={applyBtnCls}
              >
                {applyLabel}
              </button>
            </div>
          )}
        </div>
      )}

      {tags !== undefined && <span className={sepCls} />}

      {/* Edit Tags */}
      {tags !== undefined && (
      <div className="relative">
        <button type="button" onClick={() => openPopover("tags")} className={btnCls("tags")}>
          Edit Tags
        </button>
        {active === "tags" && (
          <div className={popoverCls}>
            <input
              type="text"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (showTagCreate) handleCreateTag();
                  else if (filteredTags[0]) toggleTagId(filteredTags[0].id);
                }
              }}
              placeholder={onCreateTag ? "Filter or create tag..." : "Filter tags..."}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <div className="mt-1 max-h-44 overflow-auto rounded-md border border-border">
              {showTagCreate ? (
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted/50"
                  onMouseDown={handleCreateTag}
                  disabled={tagCreating}
                >
                  {tagCreating ? "Creating..." : `Create tag: "${tagSearch.trim()}"`}
                </button>
              ) : filteredTags.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No tags yet</p>
              ) : (
                filteredTags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onMouseDown={() => toggleTagId(t.id)}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm transition-colors ${
                      tagIds.includes(t.id) ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted/50"
                    }`}
                  >
                    <span className={`h-4 w-4 flex-shrink-0 rounded border flex items-center justify-center ${tagIds.includes(t.id) ? "bg-primary border-primary" : "border-border"}`}>
                      {tagIds.includes(t.id) && <Check className="h-3 w-3 text-white" />}
                    </span>
                    {t.name}
                  </button>
                ))
              )}
            </div>
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
      )}

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

      {groupAction !== undefined && ids.length > 1 && (
        <>
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
        </>
      )}

      <span className={sepCls} />

      {/* Delete */}
      <button
        type="button"
        onClick={() => { if (!deleteDisabled) { setActive(null); setShowDeleteConfirm(true); } }}
        disabled={deleteDisabled}
        className={`flex items-center gap-1.5 px-4 py-2.5 transition-colors whitespace-nowrap ${deleteDisabled ? "opacity-40 cursor-not-allowed" : "hover:bg-white/10"}`}
        title={deleteDisabled ? deleteDisabledTitle : "Delete selected transactions"}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
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

    {/* Delete confirmation modal — rendered outside the transformed bar div so fixed positioning works correctly */}
    {showDeleteConfirm && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm rounded-lg bg-background text-foreground p-6 shadow-xl">
          <h3 className="text-base font-semibold">Delete {ids.length} transaction{ids.length !== 1 ? "s" : ""}?</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Are you sure you want to delete {ids.length === 1 ? "this transaction" : `these ${ids.length} transactions`}? This action cannot be undone.
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={deleteLoading}
              className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteLoading}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteLoading ? "Deleting..." : "Confirm Delete"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
