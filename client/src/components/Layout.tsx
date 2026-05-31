import { NavLink, Link, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useRef, useState, useEffect } from "react";
import {
  Receipt,
  TrendingUp,
  PiggyBank,
  Landmark,
  Tags,
  Repeat,
  LineChart,
  Bell,
  ChevronRight,
  PieChart,
  Keyboard,
  Waves,
  LogOut,
  Sigma,
} from "lucide-react";
import { useClerk, useUser } from "@clerk/react";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/context/NotificationContext";
import { SectionLabel, Caption } from "@/components/Typography";

// ── Keyboard shortcuts registry ───────────────────────────────────────────────

interface ShortcutEntry {
  key: string;
  description: string;
  conditional?: string;
}

const PAGE_SHORTCUTS: Record<string, ShortcutEntry[]> = {
  "/": [
    { key: "←", description: "Previous month" },
    { key: "→", description: "Next month" },
  ],
  "/expenses": [
    { key: "A", description: "Add expense" },
    { key: "G", description: "Group selected transactions", conditional: "2+ selected" },
    { key: "P", description: "Set as primary transaction", conditional: "1 grouped transaction selected (non-primary)" },
  ],
  "/income": [
    { key: "A", description: "Add income" },
  ],
};

function KeyboardShortcutsButton() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const shortcuts = PAGE_SHORTCUTS[location.pathname] ?? null;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!shortcuts) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex items-center justify-center rounded-md p-2 transition-colors",
          open
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        )}
        aria-label="Keyboard shortcuts"
      >
        <Keyboard className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-border bg-background shadow-md z-50">
          <div className="px-3 py-2 border-b border-border">
            <SectionLabel>Keyboard Shortcuts</SectionLabel>
          </div>
          <div className="px-3 py-2 space-y-2">
            {shortcuts.map((s) => (
              <div key={s.key} className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{s.description}</p>
                  {s.conditional && (
                    <Caption>{s.conditional}</Caption>
                  )}
                </div>
                <kbd className="shrink-0 inline-flex items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono font-medium">
                  {s.key}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const navItems = [
  { to: "/expenses", icon: Receipt, label: "Expenses" },
  { to: "/income", icon: TrendingUp, label: "Income" },
  { to: "/budgets", icon: PiggyBank, label: "Budgets" },
  { to: "/investments", icon: LineChart, label: "Investments" },
  { to: "/options", icon: Sigma, label: "Options" },
  { to: "/cash-flow", icon: Waves, label: "Cash Flow" },
  { to: "/recurring", icon: Repeat, label: "Recurring" },
];

const configItems = [
  { to: "/accounts", icon: Landmark, label: "Accounts" },
  { to: "/categories", icon: Tags, label: "Categories" },
  { to: "/asset-classes", icon: PieChart, label: "Asset Classes" },
];

function NotificationBell() {
  const { notifications } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const totalCount = notifications?.totalCount ?? 0;
  const pendingDividends = notifications?.pendingDividends ?? [];
  const pendingBuys = notifications?.pendingBuys ?? [];
  const pendingSales = notifications?.pendingSales ?? [];

  // Merge per-account: build a map of accountId → { name, dividends, buys, sales }
  const accountMap = new Map<string, { accountId: string; accountName: string; dividends: number; buys: number; sales: number }>();
  for (const g of pendingDividends) {
    accountMap.set(g.accountId, { accountId: g.accountId, accountName: g.accountName, dividends: g.count, buys: 0, sales: 0 });
  }
  for (const g of pendingBuys) {
    const existing = accountMap.get(g.accountId);
    if (existing) existing.buys = g.count;
    else accountMap.set(g.accountId, { accountId: g.accountId, accountName: g.accountName, dividends: 0, buys: g.count, sales: 0 });
  }
  for (const g of pendingSales) {
    const existing = accountMap.get(g.accountId);
    if (existing) existing.sales = g.count;
    else accountMap.set(g.accountId, { accountId: g.accountId, accountName: g.accountName, dividends: 0, buys: 0, sales: g.count });
  }
  const mergedAccounts = [...accountMap.values()];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleItemClick = (accountId: string) => {
    setOpen(false);
    navigate(`/investments/${accountId}?tab=activity`);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex items-center justify-center rounded-md p-2 transition-colors",
          open
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        )}
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {totalCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-down text-[9px] font-bold text-white leading-none">
            {totalCount > 99 ? "99+" : totalCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-border bg-background shadow-md z-50">
          <div className="px-3 py-2 border-b border-border">
            <SectionLabel>Notifications</SectionLabel>
          </div>

          {totalCount === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-sm text-muted-foreground">No pending notifications</p>
            </div>
          ) : (
            <div>
              {mergedAccounts.map((a) => {
                const parts: string[] = [];
                if (a.dividends > 0) parts.push(`${a.dividends} pending ${a.dividends === 1 ? "dividend" : "dividends"}`);
                if (a.buys > 0) parts.push(`${a.buys} pending ${a.buys === 1 ? "buy" : "buys"}`);
                if (a.sales > 0) parts.push(`${a.sales} pending ${a.sales === 1 ? "sale" : "sales"}`);
                return (
                  <button
                    key={a.accountId}
                    onClick={() => handleItemClick(a.accountId)}
                    className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
                  >
                    <div>
                      <p className="font-medium">{a.accountName}</p>
                      <Caption>{parts.join(" & ")} to review</Caption>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-2" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function UserMenu() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative ml-2" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center w-[34px] h-[34px] rounded-[6px] text-white text-13 font-medium transition-opacity hover:opacity-90"
        style={{
          background: "linear-gradient(135deg, var(--color-primary) 0%, oklch(0.55 0.14 320) 100%)",
          boxShadow: "0 1px 0 rgba(255,255,255,.5) inset, 0 0 0 1px rgba(15,20,40,.12), 0 4px 10px -2px color-mix(in oklab, var(--color-primary) 35%, transparent)",
        }}
        aria-label="User menu"
      >
        {user?.imageUrl && !user.imageUrl.includes("img.clerk.com") ? (
          <img src={user.imageUrl} alt="avatar" className="w-full h-full rounded-[6px] object-cover" />
        ) : (
          (user?.firstName?.[0] ?? user?.emailAddresses?.[0]?.emailAddress?.[0] ?? "?").toUpperCase()
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 rounded-md border border-border bg-background shadow-md z-50">
          <div className="px-3 py-2 border-b border-border">
            <Caption className="font-medium truncate">{user?.emailAddresses?.[0]?.emailAddress}</Caption>
          </div>
          {configItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "tp-nav-link",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
          <div className="border-t border-border">
            <button
              onClick={() => signOut({ redirectUrl: "/login" })}
              className="tp-nav-link w-full rounded-b-md"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Layout() {

  return (
    <div className="min-h-screen">
      {/* Floating glass topbar */}
      <header className="sticky top-4 z-50 mx-auto mt-4 max-w-7xl px-2">
        {/* backdrop-blur kept here (unlike body Cards): the nav is a sticky layer with
            real content scrolling behind it, so the frost is load-bearing. See the
            no-backdrop-blur-on-cards note — if the modal compositing bar resurfaces on
            this bar, decouple shadow-card from the backdrop-filter element. */}
        <div className="flex h-14 items-center gap-6 rounded-xl border border-border bg-card px-4 backdrop-blur-[22px] backdrop-saturate-[140%] shadow-card">
          <Link to="/" className="mr-8 hover:opacity-80 transition-opacity">
            <img src="/beacon-logo.png" alt="Beacon" width={92} height={26} />
          </Link>

          <nav className="flex flex-1 gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "tp-nav-link",
                    isActive
                      ? "bg-white/[.78] shadow-[0_1px_0_rgba(255,255,255,.85)_inset,0_1px_2px_rgba(15,20,40,.06),0_4px_10px_-4px_rgba(15,20,40,.12)]"
                      : "hover:bg-white/40"
                  )
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <KeyboardShortcutsButton />

          {/* Notification bell */}
          <NotificationBell />

          {/* User avatar / settings / sign out */}
          <UserMenu />
        </div>
      </header>

      {/* Page content */}
      <main className="mx-auto max-w-7xl p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
