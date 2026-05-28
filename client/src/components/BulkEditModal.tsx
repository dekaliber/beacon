import { useState, useMemo, useEffect } from "react";
import { Repeat, ChevronDown } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { MultiSelectDropdown } from "@/components/MultiSelectDropdown";
import type { MultiSelectOption } from "@/components/MultiSelectDropdown";
import { bulkUpdateExpenses } from "@/api";
import type { Category, Tag } from "@/types";

interface BulkEditModalProps {
  open: boolean;
  ids: string[];
  recurringCount: number;
  categories: Category[];
  tags: Tag[];
  onClose: () => void;
  onSuccess: () => void;
}

type TagMode = "add" | "remove" | "replace";

export function BulkEditModal({
  open, ids, recurringCount, categories, tags, onClose, onSuccess,
}: BulkEditModalProps) {
  const [descEnabled, setDescEnabled] = useState(false);
  const [categoryEnabled, setCategoryEnabled] = useState(false);
  const [tagsEnabled, setTagsEnabled] = useState(false);

  const [description, setDescription] = useState("");
  // undefined = not yet chosen (invalid); null = "No category"; string = category ID
  const [categoryId, setCategoryId] = useState<string | null | undefined>(undefined);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<TagMode>("add");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state whenever modal opens
  useEffect(() => {
    if (open) {
      setDescEnabled(false);
      setCategoryEnabled(false);
      setTagsEnabled(false);
      setDescription("");
      setCategoryId(undefined);
      setTagIds([]);
      setTagMode("add");
      setError(null);
      setLoading(false);
    }
  }, [open]);

  const parentCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories]);
  const childCategories = useMemo(() => categories.filter((c) => c.parentId), [categories]);

  const flatCategoryOptions = useMemo(() => {
    const opts: { id: string; label: string }[] = [];
    for (const parent of parentCategories) {
      const children = childCategories.filter((c) => c.parentId === parent.id);
      if (children.length === 0) {
        opts.push({ id: parent.id, label: parent.name });
      } else {
        for (const child of children) {
          opts.push({ id: child.id, label: `${parent.name} > ${child.name}` });
        }
      }
    }
    return opts;
  }, [parentCategories, childCategories]);

  const tagOptions = useMemo<MultiSelectOption[]>(
    () => tags.map((t) => ({ id: t.id, label: t.name })),
    [tags],
  );

  const descValid = !descEnabled || description.trim() !== "";
  const catValid = !categoryEnabled || categoryId !== undefined;
  const tagsValid = !tagsEnabled || tagMode === "replace" || tagIds.length > 0;
  const anyEnabled = descEnabled || categoryEnabled || tagsEnabled;
  const canApply = anyEnabled && descValid && catValid && tagsValid && !loading;

  const handleApply = async () => {
    setLoading(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (descEnabled && description.trim()) {
        patch.description = description.trim();
      }
      if (categoryEnabled) {
        patch.categoryId = categoryId ?? null;
      }
      if (tagsEnabled) {
        patch.tagIds = tagIds;
        patch.tagMode = tagMode;
      }
      await bulkUpdateExpenses(ids, patch);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setLoading(false);
    }
  };

  const categorySelectValue =
    categoryId === undefined ? "" : categoryId === null ? "__null__" : categoryId;

  const handleCategoryChange = (val: string) => {
    if (val === "") setCategoryId(undefined);
    else if (val === "__null__") setCategoryId(null);
    else setCategoryId(val);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit ${ids.length} transaction${ids.length !== 1 ? "s" : ""}`}
    >
      <div className="space-y-5">
        {/* Description */}
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={descEnabled}
              onChange={(e) => setDescEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span className="text-sm font-medium">Description</span>
          </label>
          {descEnabled && (
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter new description..."
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="ml-6 w-[calc(100%-1.5rem)] rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          )}
        </div>

        {/* Category */}
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={categoryEnabled}
              onChange={(e) => {
                setCategoryEnabled(e.target.checked);
                if (e.target.checked) setCategoryId(undefined);
              }}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span className="text-sm font-medium">Category</span>
          </label>
          {categoryEnabled && (
            <div className="relative ml-6 w-[calc(100%-1.5rem)]">
              <select
                value={categorySelectValue}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className="w-full appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
              >
                <option value="" disabled>Select a category...</option>
                <option value="__null__">No category (clear)</option>
                {flatCategoryOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
            </div>
          )}
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={tagsEnabled}
              onChange={(e) => setTagsEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span className="text-sm font-medium">Tags</span>
          </label>
          {tagsEnabled && (
            <div className="ml-6 space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="tp-caption">Mode:</span>
                {(["add", "remove", "replace"] as TagMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setTagMode(mode)}
                    className={`rounded px-2 py-0.5 text-xs font-medium capitalize transition-colors ${
                      tagMode === mode
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <MultiSelectDropdown
                options={tagOptions}
                selected={tagIds}
                onChange={setTagIds}
                placeholder={
                  tagMode === "replace" && tagIds.length === 0
                    ? "None (clears all tags)"
                    : "Select tags..."
                }
              />
              {tagMode === "replace" && tagIds.length === 0 && (
                <p className="text-xs text-amber-600">
                  All tags will be removed from the selected expenses.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Recurring notice */}
        {recurringCount > 0 && (
          <div className="flex items-start gap-2 rounded-md bg-blue-50 px-3 py-2.5 text-sm text-blue-800">
            <Repeat className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>
              {recurringCount === 1 ? "1 selected expense is" : `${recurringCount} selected expenses are`} recurring.{" "}
              Changes will only apply to the selected instances — recurring rules and future
              instances are unaffected.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={!canApply}>
            {loading
              ? "Applying..."
              : `Apply to ${ids.length} transaction${ids.length !== 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
