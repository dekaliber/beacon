import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "@/components/Layout";
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

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/income" element={<IncomePage />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/reimbursements" element={<ReimbursementsPage />} />
          <Route path="/investments" element={<Investments />} />
          <Route path="/investments/:accountId" element={<InvestmentAccount />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
