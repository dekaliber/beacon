import { NavLink, Outlet } from "react-router-dom";
import { Receipt, TrendingUp, PiggyBank, LineChart, Waves, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { UserMenu } from "@/components/Layout";

const bottomNavItems = [
  { to: "/expenses", icon: Receipt, label: "Expenses" },
  { to: "/income", icon: TrendingUp, label: "Income" },
  { to: "/budgets", icon: PiggyBank, label: "Budgets" },
  { to: "/investments", icon: LineChart, label: "Invest" },
  { to: "/cash-flow", icon: Waves, label: "Cash Flow" },
  { to: "/recurring", icon: Repeat, label: "Recurring" },
];

export function MobileLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b border-border bg-background">
        <div className="flex h-14 items-center justify-between px-4">
          <NavLink to="/"><img src="/beacon-logo.png" alt="Beacon" width={108} height={30} /></NavLink>
          <UserMenu />
        </div>
      </header>

      <main className="flex flex-1 flex-col p-4 pb-24">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background">
        <div className="flex">
          {bottomNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-normal transition-colors",
                  isActive ? "text-primary" : "text-muted-foreground"
                )
              }
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
