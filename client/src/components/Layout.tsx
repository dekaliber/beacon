import { NavLink, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Receipt,
  TrendingUp,
  PiggyBank,
  Landmark,
  Tags,
  Tag,
  Repeat,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/expenses", icon: Receipt, label: "Expenses" },
  { to: "/income", icon: TrendingUp, label: "Income" },
  { to: "/budgets", icon: PiggyBank, label: "Budgets" },
  { to: "/accounts", icon: Landmark, label: "Accounts" },
  { to: "/categories", icon: Tags, label: "Categories" },
  { to: "/tags", icon: Tag, label: "Tags" },
  { to: "/recurring", icon: Repeat, label: "Recurring" },
  { to: "/reimbursements", icon: AlertCircle, label: "Reimbursements" },
];

export function Layout() {
  return (
    <div className="min-h-screen bg-muted/30">
      {/* Top nav bar */}
      <header className="sticky top-0 z-50 border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-7xl items-center px-4">
          <h1 className="mr-8 text-lg font-bold text-primary">Beacon</h1>
          <nav className="flex gap-1 overflow-x-auto">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
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
        </div>
      </header>

      {/* Page content */}
      <main className="mx-auto max-w-7xl p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
