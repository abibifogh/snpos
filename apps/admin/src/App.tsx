import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Spinner, Notice } from '@snpos/ui';
import { canOpen, opensPage, catalogueSides, unavailableWords, NAV_MERGES, navFor } from '@snpos/core';
import type { ReactElement } from 'react';
import { useSession } from './session';
import { Login } from './pages/Login';
import { Shell } from './Shell';
import { AccountPage } from './pages/Account';
import { HelpPage } from './pages/Help';
import { ExpensesPage } from './pages/Expenses';
import { ImprestPage } from './pages/Imprest';
import { CataloguePage } from './pages/Catalogue';
import { WastePage } from './pages/Waste';
import { CleaningPage } from './pages/Cleaning';
import { PurchaseOrdersPage } from './pages/PurchaseOrders';
import { OrdersPage } from './pages/Orders';
import {
  TodayHub, ProductsHub, CustomersHub, MakersHub, ShiftsHub, ReportsHub, VenuesHub, SettingsHub, StaffHub,
  TodoHub, CountsHub, DifferencesHub, BookingsHub, AccountingHub,
} from './pages/Hubs';

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
        {/* Which of the two reasons it is. A page switched off and a page not
            granted are different facts, and saying the second about the first
            sends somebody hunting for a checkbox that does not exist. */}
        <Notice>{unavailableWords(section, profile, settings)}</Notice>
      </>
    );

  /** A page that stands for several sides: open if any of them is. */
  const sidesOf = (to: string) => Object.values(NAV_MERGES.find((m) => m.to === to)?.keys ?? {});
  /**
   * A page made of tabs: open if any tab is, and each tab then shows only to
   * whoever could open it before. The first key names the refusal.
   */
  const guardSome = (keys: string[], element: ReactElement) =>
    keys.some((k) => opensPage(k, profile, settings)) ? element : guard(keys[0] ?? '', element);

  const firstPage = navFor(profile, settings).flatMap((g) => g.links)[0]?.to;
  const home = ['dashboard', 'close_day'].some((k) => opensPage(k, profile, settings)) || !firstPage || firstPage === '/'
    ? guardSome(['dashboard', 'close_day'], <TodayHub />)
    : <Navigate to={firstPage} replace />;

  return (
    <Shell>
      <Routes>
        {/* Today, or for somebody without it (an auditor) the first page they have, rather than a refusal. */}
        <Route path="/" element={home} />
        <Route path="/orders" element={guard('orders', <OrdersPage />)} />
        <Route path="/reports" element={guardSome(['reports'], <ReportsHub />)} />
        {/* Products: items, categories and options, a tab each. Each side is
            still its own grant; the page offers only the sides this person
            holds. The old addresses still work, redirected to their tab. */}
        <Route
          path="/catalogue/items"
          element={guardSome([...sidesOf('/catalogue/items'), ...sidesOf('/catalogue/categories'), 'menu_options', 'vouchers'], <ProductsHub />)}
        />
        <Route path="/catalogue/categories" element={<ToTab path="/catalogue/items" tab="categories" />} />
        <Route path="/menu/options" element={<ToTab path="/catalogue/items" tab="options" />} />
        <Route path="/menu/items" element={<ToTab path="/catalogue/items" tab="items" side="kitchen" />} />
        <Route path="/menu/categories" element={<ToTab path="/catalogue/items" tab="categories" side="kitchen" />} />
        <Route path="/shop/items" element={<ToTab path="/catalogue/items" tab="items" side="craft" />} />
        <Route path="/shop/categories" element={<ToTab path="/catalogue/items" tab="categories" side="craft" />} />
        <Route path="/bar/items" element={<ToTab path="/catalogue/items" tab="items" side="bar" />} />
        <Route path="/bar/categories" element={<ToTab path="/catalogue/items" tab="categories" side="bar" />} />
        <Route path="/expenses" element={guard('expenses', <ExpensesPage />)} />
        {/* To do: what Approvals was, and the follow-ups. The old address opens its first tab. */}
        <Route path="/todo" element={guardSome(['waiting', 'differences'], <TodoHub />)} />
        <Route path="/waiting" element={<ToTab path="/todo" tab="decide" />} />
        <Route path="/close-day" element={<ToTab path="/" tab="close" />} />
        <Route path="/group-bookings" element={guardSome(['group_bookings', 'orders'], <BookingsHub />)} />
        <Route path="/imprest" element={guard('imprest', <ImprestPage />)} />
        <Route path="/customers" element={guardSome(['customers', 'tabs'], <CustomersHub />)} />
        <Route path="/tabs" element={<ToTab path="/customers" tab="tabs" />} />
        {/* The books: Reports, and Accounting with the accountant's tools behind a switch. */}
        <Route path="/accounting" element={guard('accounting', <AccountingHub />)} />
        <Route path="/accountant" element={<ToSet />} />
        <Route path="/vouchers" element={<ToTab path="/catalogue/items" tab="discounts" />} />
        <Route path="/consignors" element={guardSome(['consignors', 'intake', 'payouts'], <MakersHub />)} />
        <Route path="/intake" element={<ToTab path="/consignors" tab="received" />} />
        <Route path="/payouts" element={<ToTab path="/consignors" tab="payouts" />} />
        {/* Counts, every place: the log, the sheet, and what was missed. The old addresses open the sheet on their side. */}
        <Route path="/counts" element={guardSome(sidesOf('/counts'), <CountsHub />)} />
        <Route path="/count" element={<ToTab path="/counts" tab="count" />} />
        <Route path="/stocktake" element={<Navigate to="/counts?tab=count&side=craft" replace />} />
        <Route path="/bar/counts" element={<Navigate to="/counts?tab=count&side=bar" replace />} />
        {/* Differences: review, what is owed, the deductions and HIVE. Staff owing is a tab of it. */}
        <Route path="/differences" element={guardSome(['differences', 'staff_owing'], <DifferencesHub />)} />
        {/* Stock, with Places and Waste among its tabs. */}
        <Route path="/stock" element={guardSome([...sidesOf('/stock'), 'waste'], <StockRoute />)} />
        <Route path="/bar/stock" element={<Navigate to="/stock?side=bar" replace />} />
        <Route path="/locations" element={<ToTab path="/stock" tab="places" />} />
        <Route path="/waste" element={<ToTab path="/stock" tab="waste" side="kitchen" />} />
        <Route path="/shifts" element={guard('shifts', <ShiftsHub />)} />
        <Route path="/staff-owing" element={<ToTab path="/differences" tab="owing" />} />
        <Route path="/staff" element={guardSome(['staff'], <StaffHub />)} />
        <Route path="/venues" element={guardSome(['venues', 'tables', 'stations'], <VenuesHub />)} />
        <Route path="/tables" element={<ToTab path="/venues" tab="tables" />} />
        <Route path="/stations" element={<ToTab path="/venues" tab="stations" />} />
        <Route path="/cleaning" element={guard('cleaning', <CleaningPage />)} />
        <Route path="/purchase-orders" element={guard('purchase_orders', <PurchaseOrdersPage />)} />
        <Route path="/settings" element={guardSome(['settings', 'features', 'health', 'erase'], <SettingsHub />)} />
        <Route path="/features" element={<ToTab path="/settings" tab="features" />} />
        <Route path="/health" element={<ToTab path="/settings" tab="data" />} />
        <Route path="/erase" element={<ToTab path="/settings" tab="data" />} />
        {/* Always yours, whatever your role. */}
        <Route path="/account" element={<AccountPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

/** The accountant's tools, which were their own page: Accounting, on that side of its switch. */
function ToSet() {
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  if (!p.has('tab')) p.set('set', 'accountant');
  return <Navigate to={`/accounting?${p.toString()}`} replace />;
}

/** Stock for anybody with a side of it; Waste alone for somebody given only that. */
function StockRoute() {
  const { profile, settings } = useSession();
  return catalogueSides('/stock', profile, settings).length > 0 ? <CataloguePage kind="stock" /> : <WastePage />;
}

/**
 * An old address, sent to the tab it became.
 *
 * Whatever else was in the address comes along (?receive=1 opens the form on
 * Goods received as it did on its own page), and the side when the old
 * address named one.
 */
function ToTab({ path, tab, side }: { path: string; tab: string; side?: string }) {
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  p.set('tab', tab);
  if (side && !p.has('side')) p.set('side', side);
  return <Navigate to={`${path}?${p.toString()}`} replace />;
}
