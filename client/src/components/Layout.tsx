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
} from "lucide-react";
import { useClerk, useUser } from "@clerk/react";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/context/NotificationContext";

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
    <div className="relative ml-2" ref={ref}>
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
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Keyboard Shortcuts
            </p>
          </div>
          <div className="px-3 py-2 space-y-2">
            {shortcuts.map((s) => (
              <div key={s.key} className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{s.description}</p>
                  {s.conditional && (
                    <p className="text-xs text-muted-foreground">{s.conditional}</p>
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
    <div className="relative ml-2" ref={ref}>
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
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white leading-none">
            {totalCount > 99 ? "99+" : totalCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-border bg-background shadow-md z-50">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Notifications
            </p>
          </div>

          {totalCount === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-sm text-muted-foreground">No pending notifications</p>
            </div>
          ) : (
            <div>
              {pendingDividends.length > 0 && (
                <div>
                  <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Pending Dividends
                  </p>
                  {pendingDividends.map((group) => (
                    <button
                      key={group.accountId}
                      onClick={() => handleItemClick(group.accountId)}
                      className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
                    >
                      <div>
                        <p className="font-medium">{group.accountName}</p>
                        <p className="text-xs text-muted-foreground">
                          {group.count} pending {group.count === 1 ? "dividend" : "dividends"} to review
                        </p>
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              )}
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

  const initials = user?.firstName?.[0] ?? user?.emailAddresses?.[0]?.emailAddress?.[0] ?? "?";

  return (
    <div className="relative ml-2" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center justify-center rounded-full w-8 h-8 text-xs font-semibold transition-colors",
          open
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        )}
        aria-label="User menu"
      >
        {user?.imageUrl ? (
          <img src={user.imageUrl} alt="avatar" className="w-8 h-8 rounded-full object-cover" />
        ) : (
          initials.toUpperCase()
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 rounded-md border border-border bg-background shadow-md z-50">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs font-medium truncate">{user?.emailAddresses?.[0]?.emailAddress}</p>
          </div>
          {configItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors",
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
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors rounded-b-md"
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
    <div className="min-h-screen bg-muted">
      {/* Top nav bar */}
      <header className="sticky top-0 z-50 border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-7xl items-center px-4">
          <Link to="/" className="mr-8 hover:opacity-80 transition-opacity">
            <img src="/beacon-logo.png" alt="Beacon" width={108} height={30} />
          </Link>

          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
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
