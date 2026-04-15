import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { NotificationProvider } from "@/context/NotificationContext";
import { DemoProvider } from "@/context/DemoContext";
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

function App() {
  return (
    <BrowserRouter>
      <DemoProvider>
      <NotificationProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/income" element={<IncomePage />} />
          <Route path="/income/tax-estimator" element={<TaxEstimatorPage />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/budgets/monthly-spending" element={<MonthlySpending />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/expenses/tags" element={<TagsPage />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/cash-flow" element={<CashFlow />} />
          <Route path="/expenses/reimbursements" element={<ReimbursementsPage />} />
          <Route path="/investments" element={<Investments />} />
          <Route path="/investments/securities" element={<SecuritiesPage />} />
          <Route path="/investments/withdrawals" element={<WithdrawalsPage />} />
          <Route path="/investments/:accountId" element={<InvestmentAccount />} />
          <Route path="/asset-classes" element={<AssetClassesPage />} />
        </Route>
      </Routes>
      </NotificationProvider>
      </DemoProvider>
    </BrowserRouter>
  );
}

export default App;
