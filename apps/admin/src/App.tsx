import { Routes, Route, Navigate } from 'react-router-dom';
import { Spinner, Notice } from '@snpos/ui';
import { canOpen, NAV_MERGES } from '@snpos/core';
import type { ReactElement } from 'react';
import { useSession } from './session';
import { Login } from './pages/Login';
import { Shell } from './Shell';
import { Dashboard } from './pages/Dashboard';
import { SettingsPage } from './pages/SettingsPage';
import { FeaturesPage } from './pages/Features';
import { VenuesPage } from './pages/Venues';
import { AccountPage } from './pages/Account';
import { HelpPage } from './pages/Help';
import { AddonsPage } from './pages/Addons';
import { ExpensesPage } from './pages/Expenses';
import { WaitingPage } from './pages/Waiting';
import { HealthPage } from './pages/Health';
import { CataloguePage } from './pages/Catalogue';
import { ImprestPage } from './pages/Imprest';
import { CustomersPage } from './pages/Customers';
import { AccountingPage } from './pages/Accounting';
import { TablesPage } from './pages/Tables';
import { ShiftsPage } from './pages/Shifts';
import { StaffPage } from './pages/Staff';
import { WastePage } from './pages/Waste';
import { ReportsPage } from './pages/Reports';
import { StationsPage } from './pages/Stations';
import { OrdersPage } from './pages/Orders';
import { PurgePage } from './pages/Purge';
import { VouchersPage } from './pages/Vouchers';
import { ConsignorsPage } from './pages/Consignors';
import { TabsPage } from './pages/Tabs';
import { IntakePage } from './pages/Intake';
import { StocktakePage } from './pages/Stocktake';
import { BarCountsPage } from './pages/BarCounts';
import { LocationsPage } from './pages/Locations';
import { PayoutsPage } from './pages/Payouts';

export function App() {
  const { user, profile, settings, loading } = useSession();

  if (loading) {
    return (
      <div className="login-wrap">
        <Spinner />
      </div>
    );
  }

  if (!user) return <Login />;

  /**
   * A page this person is not allowed to open.
   *
   * Refused here as well as hidden in the navigation. Hiding a link stops it
   * being clicked; it does nothing about the address being typed, pasted or
   * still sitting in somebody's history from before their access changed.
   */
  const guard = (section: string, element: ReactElement) =>
    canOpen(section, profile, settings) ? element : (
      <>
        <h1>Not available</h1>
        <Notice>
          Your account does not have access to this page. Ask an admin if you think it should.
        </Notice>
      </>
    );

  /** A page that stands for several sides: open if any of them is. */
  const guardAny = (to: string, element: ReactElement) => {
    const keys = Object.values(NAV_MERGES.find((m) => m.to === to)?.keys ?? {});
    return keys.some((k) => canOpen(k, profile, settings)) ? element : guard(keys[0] ?? '', element);
  };

  return (
    <Shell>
      <Routes>
        <Route path="/" element={guard('dashboard', <Dashboard />)} />
        <Route path="/orders" element={guard('orders', <OrdersPage />)} />
        <Route path="/reports" element={guard('reports', <ReportsPage />)} />
        {/* One catalogue page per kind, with a side switch on it. Each side is
            still its own grant; the page offers only the sides this person
            holds. The old per-side addresses still work, redirected. */}
        <Route path="/catalogue/categories" element={guardAny('/catalogue/categories', <CataloguePage kind="categories" />)} />
        <Route path="/catalogue/items" element={guardAny('/catalogue/items', <CataloguePage kind="items" />)} />
        <Route path="/menu/categories" element={<Navigate to="/catalogue/categories?side=kitchen" replace />} />
        <Route path="/menu/items" element={<Navigate to="/catalogue/items?side=kitchen" replace />} />
        <Route path="/shop/categories" element={<Navigate to="/catalogue/categories?side=craft" replace />} />
        <Route path="/shop/items" element={<Navigate to="/catalogue/items?side=craft" replace />} />
        <Route path="/menu/options" element={guard('menu_options', <AddonsPage />)} />
        <Route path="/expenses" element={guard('expenses', <ExpensesPage />)} />
        <Route path="/waiting" element={guard('waiting', <WaitingPage />)} />
        <Route path="/health" element={guard('health', <HealthPage />)} />
        <Route path="/imprest" element={guard('imprest', <ImprestPage />)} />
        <Route path="/customers" element={guard('customers', <CustomersPage />)} />
        <Route path="/accounting" element={guard('accounting', <AccountingPage />)} />
        <Route path="/vouchers" element={guard('vouchers', <VouchersPage />)} />
        <Route path="/consignors" element={guard('consignors', <ConsignorsPage />)} />
        <Route path="/tabs" element={guard('tabs', <TabsPage />)} />
        <Route path="/intake" element={guard('intake', <IntakePage />)} />
        <Route path="/stocktake" element={guard('stocktake', <StocktakePage />)} />
        {/* The bar reuses the kitchen's screens for its catalogue and its
            shelves — a dish and a cocktail are both a menu item with a recipe,
            and a bottle is an ingredient. What it does NOT share is the
            counting, which is why that has a screen of its own. */}
        <Route path="/bar/categories" element={<Navigate to="/catalogue/categories?side=bar" replace />} />
        <Route path="/bar/items" element={<Navigate to="/catalogue/items?side=bar" replace />} />
        <Route path="/bar/stock" element={<Navigate to="/stock?side=bar" replace />} />
        <Route path="/bar/counts" element={guard('bar_counts', <BarCountsPage />)} />
        <Route path="/locations" element={guard('locations', <LocationsPage />)} />
        <Route path="/payouts" element={guard('payouts', <PayoutsPage />)} />
        <Route path="/venues" element={guard('venues', <VenuesPage />)} />
        <Route path="/tables" element={guard('tables', <TablesPage />)} />
        <Route path="/shifts" element={guard('shifts', <ShiftsPage />)} />
        <Route path="/staff" element={guard('staff', <StaffPage />)} />
        <Route path="/stock" element={guardAny('/stock', <CataloguePage kind="stock" />)} />
        <Route path="/stations" element={guard('stations', <StationsPage />)} />
        <Route path="/waste" element={guard('waste', <WastePage />)} />
        <Route path="/features" element={guard('features', <FeaturesPage />)} />
        <Route path="/settings" element={guard('settings', <SettingsPage />)} />
        <Route path="/erase" element={guard('erase', <PurgePage />)} />
        {/* Always yours, whatever your role. */}
        <Route path="/account" element={<AccountPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
