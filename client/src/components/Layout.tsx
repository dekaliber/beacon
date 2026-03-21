import { NavLink, Link, Outlet } from "react-router-dom";
import { useRef, useState, useEffect } from "react";
import {
  Receipt,
  TrendingUp,
  PiggyBank,
  Landmark,
  Tags,
  Tag,
  Repeat,
  AlertCircle,
  Settings,
  LineChart,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/expenses", icon: Receipt, label: "Expenses" },
  { to: "/income", icon: TrendingUp, label: "Income" },
  { to: "/budgets", icon: PiggyBank, label: "Budgets" },
  { to: "/investments", icon: LineChart, label: "Investments" },
  { to: "/recurring", icon: Repeat, label: "Recurring" },
  { to: "/reimbursements", icon: AlertCircle, label: "Reimbursements" },
];

const configItems = [
  { to: "/accounts", icon: Landmark, label: "Accounts" },
  { to: "/categories", icon: Tags, label: "Categories" },
  { to: "/tags", icon: Tag, label: "Tags" },
];

export function Layout() {
  const [configOpen, setConfigOpen] = useState(false);
  const configRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (configRef.current && !configRef.current.contains(e.target as Node)) {
        setConfigOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Top nav bar */}
      <header className="sticky top-0 z-50 border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-7xl items-center px-4">
          <Link to="/" className="mr-8 text-lg font-bold text-primary hover:opacity-80 transition-opacity">
            Beacon
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
                <span className="hidden sm:inline">{item.label}</span>
              </NavLink>
            ))}
          </nav>

          {/* Config gear menu */}
          <div className="relative ml-2" ref={configRef}>
            <button
              onClick={() => setConfigOpen((o) => !o)}
              className={cn(
                "flex items-center justify-center rounded-md p-2 transition-colors",
                configOpen
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
              aria-label="Configure"
            >
              <Settings className="h-4 w-4" />
            </button>
            {configOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 rounded-md border border-border bg-background shadow-md z-50">
                {configItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={() => setConfigOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors first:rounded-t-md last:rounded-b-md",
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
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Page content */}
      <main className="mx-auto max-w-7xl p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
