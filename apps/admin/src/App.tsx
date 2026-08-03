import { Routes, Route, Navigate } from 'react-router-dom';
import { Spinner } from '@snpos/ui';
import { useSession } from './session';
import { Login } from './pages/Login';
import { Shell } from './Shell';
import { Dashboard } from './pages/Dashboard';
import { SettingsPage } from './pages/SettingsPage';
import { CategoriesPage } from './pages/Categories';
import { MenuItemsPage } from './pages/MenuItems';
import { FeaturesPage } from './pages/Features';
import { VenuesPage } from './pages/Venues';
import { AccountPage } from './pages/Account';
import { HelpPage } from './pages/Help';
import { AddonsPage } from './pages/Addons';
import { ExpensesPage } from './pages/Expenses';
import { TablesPage } from './pages/Tables';
import { ShiftsPage } from './pages/Shifts';
import { StaffPage } from './pages/Staff';
import { StockPage } from './pages/Stock';
import { WastePage } from './pages/Waste';
import { ReportsPage } from './pages/Reports';
import { OrdersPage } from './pages/Orders';
import { PurgePage } from './pages/Purge';
import { StationsPage } from './pages/Stations';

export function App() {
  const { user, loading } = useSession();

  if (loading) {
    return (
      <div className="login-wrap">
        <Spinner />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/menu/categories" element={<CategoriesPage />} />
        <Route path="/menu/items" element={<MenuItemsPage />} />
        <Route path="/menu/options" element={<AddonsPage />} />
        <Route path="/expenses" element={<ExpensesPage />} />
        <Route path="/venues" element={<VenuesPage />} />
        <Route path="/tables" element={<TablesPage />} />
        <Route path="/shifts" element={<ShiftsPage />} />
        <Route path="/staff" element={<StaffPage />} />
        <Route path="/stock" element={<StockPage />} />
        <Route path="/stations" element={<StationsPage />} />
        <Route path="/waste" element={<WastePage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/erase" element={<PurgePage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
