import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { Layout } from "@/components/Layout";
import { MobileLayout } from "@/components/MobileLayout";
import { NotificationProvider } from "@/context/NotificationContext";
import { DemoProvider } from "@/context/DemoContext";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Dashboard } from "@/pages/Dashboard";
import { Expenses } from "@/pages/Expenses";
import { Budgets } from "@/pages/Budgets";
import { Accounts } from "@/pages/Accounts";
import { Categories } from "@/pages/Categories";
import { Recurring } from "@/pages/Recurring";
import { IncomePage } from "@/pages/Income";
import { TagsPage } from "@/pages/Tags";
import { ReimbursementsPage } from "@/pages/Reimbursements";
import { Investments } from "@/pages/Investments";
import { InvestmentAccount } from "@/pages/InvestmentAccount";
import { AssetClassesPage } from "@/pages/AssetClasses";
import { SecuritiesPage } from "@/pages/Securities";
import { CashFlow } from "@/pages/CashFlow";
import { WithdrawalsPage } from "@/pages/Withdrawals";
import { MonthlySpending } from "@/pages/MonthlySpending";
import { TaxEstimatorPage } from "@/pages/TaxEstimator";
import { Login } from "@/pages/Login";
import { setTokenGetter } from "@/lib/authToken";
import { NotAvailableOnMobile } from "@/pages/mobile/NotAvailableOnMobile";
import { MobileDashboard } from "@/pages/mobile/MobileDashboard";
import { MobileExpenses } from "@/pages/mobile/MobileExpenses";
import { MobileIncome } from "@/pages/mobile/MobileIncome";
import { MobileBudgets } from "@/pages/mobile/MobileBudgets";
import { MobileInvestments } from "@/pages/mobile/MobileInvestments";
import { MobileCashFlow } from "@/pages/mobile/MobileCashFlow";
import { MobileRecurring } from "@/pages/mobile/MobileRecurring";

function AuthTokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenGetter(getToken);
  }, [getToken]);
  return null;
}

/** Redirects unauthenticated users to /login; renders child routes otherwise. */
function RequireAuth() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Renders the desktop or mobile layout depending on screen width. */
function ResponsiveLayout() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileLayout /> : <Layout />;
}

/** Renders the appropriate page component for the current screen width. */
function ResponsivePage({
  desktop,
  mobile,
}: {
  desktop: React.ReactElement;
  mobile?: React.ReactElement;
}) {
  const isMobile = useIsMobile();
  return isMobile ? (mobile ?? <NotAvailableOnMobile />) : desktop;
}

function App() {
  return (
    <BrowserRouter>
      <AuthTokenBridge />
      <DemoProvider>
      <NotificationProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route element={<ResponsiveLayout />}>
            <Route path="/" element={<ResponsivePage desktop={<Dashboard />} mobile={<MobileDashboard />} />} />
            <Route path="/expenses" element={<ResponsivePage desktop={<Expenses />} mobile={<MobileExpenses />} />} />
            <Route path="/income" element={<ResponsivePage desktop={<IncomePage />} mobile={<MobileIncome />} />} />
            <Route path="/income/tax-estimator" element={<ResponsivePage desktop={<TaxEstimatorPage />} />} />
            <Route path="/budgets" element={<ResponsivePage desktop={<Budgets />} mobile={<MobileBudgets />} />} />
            <Route path="/budgets/monthly-spending" element={<ResponsivePage desktop={<MonthlySpending />} />} />
            <Route path="/accounts" element={<ResponsivePage desktop={<Accounts />} />} />
            <Route path="/categories" element={<ResponsivePage desktop={<Categories />} />} />
            <Route path="/expenses/tags" element={<ResponsivePage desktop={<TagsPage />} />} />
            <Route path="/recurring" element={<ResponsivePage desktop={<Recurring />} mobile={<MobileRecurring />} />} />
            <Route path="/cash-flow" element={<ResponsivePage desktop={<CashFlow />} mobile={<MobileCashFlow />} />} />
            <Route path="/expenses/reimbursements" element={<ResponsivePage desktop={<ReimbursementsPage />} />} />
            <Route path="/investments" element={<ResponsivePage desktop={<Investments />} mobile={<MobileInvestments />} />} />
            <Route path="/investments/securities" element={<ResponsivePage desktop={<SecuritiesPage />} />} />
            <Route path="/investments/withdrawals" element={<ResponsivePage desktop={<WithdrawalsPage />} />} />
            <Route path="/investments/:accountId" element={<ResponsivePage desktop={<InvestmentAccount />} />} />
            <Route path="/asset-classes" element={<ResponsivePage desktop={<AssetClassesPage />} />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </NotificationProvider>
      </DemoProvider>
    </BrowserRouter>
  );
}

export default App;
