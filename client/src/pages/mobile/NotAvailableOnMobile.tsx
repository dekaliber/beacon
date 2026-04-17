import { Monitor } from "lucide-react";

export function NotAvailableOnMobile() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Monitor className="mb-4 h-10 w-10 text-muted-foreground" />
      <h2 className="text-base font-semibold">Desktop only</h2>
      <p className="mt-1 text-sm text-muted-foreground">This feature is available on desktop.</p>
    </div>
  );
}
