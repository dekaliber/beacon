// This page has been superseded by the inline group UI on the Expenses page.
// Transaction groups are now created and managed directly from the bulk-edit bar.
export function TransactionGroupsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="tp-page-title">Transaction Groups</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Transaction groups are now managed directly from the Expenses page.
          Select two or more expenses and use the bulk-edit bar to group them.
        </p>
      </div>
    </div>
  );
}
