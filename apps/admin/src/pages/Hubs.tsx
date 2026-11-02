import { canOpen, bookAreas, NAV_MERGES } from '@snpos/core';
import { Hub, HubTabs, HubTitle } from '../components/Hub';
import { CloseDayPage } from '../components/CloseDay';
import { useSession, useMoney } from '../session';
import { Dashboard } from './Dashboard';
import { CataloguePage } from './Catalogue';
import { AddonsPage } from './Addons';
import { CustomersPage } from './Customers';
import { TabsPage } from './Tabs';
import { ConsignorsPage } from './Consignors';
import { IntakePage } from './Intake';
import { PayoutsPage } from './Payouts';
import { ShiftsPage } from './Shifts';
import { StaffOwingPage } from './StaffOwing';
import { ReportsPage } from './Reports';
import { AccountingPage } from './Accounting';
import type { Tab as BookTab } from './Accounting';
import { VenuesPage } from './Venues';
import { TablesPage } from './Tables';
import { StationsPage } from './Stations';
import { FeaturesPage } from './Features';
import { SettingsPage } from './SettingsPage';
import type { SettingsSection } from './SettingsPage';
import { HealthPage } from './Health';
import { PurgePage } from './Purge';
import { StaffPage } from './Staff';

/**
 * The admin's pages that are several pages, each a row of tabs. See Hub.
 *
 * Every tab is offered on exactly the grant that opened it as a page, so
 * nobody gains or loses anything by the move; the old addresses redirect to
 * the tab (see App).
 */

/** Whether this person may open any side of a merged page. */
function useAnySide() {
  const { profile, settings } = useSession();
  return (to: string) => Object.values(NAV_MERGES.find((m) => m.to === to)?.keys ?? {})
    .some((k) => canOpen(k, profile, settings));
}

function useCan() {
  const { profile, settings } = useSession();
  return (key: string) => canOpen(key, profile, settings);
}

/** Today: the day so far, and whether it is finished. */
export function TodayHub() {
  const can = useCan();
  const money = useMoney();
  return (
    <Hub
      ariaLabel="Today"
      tabs={[
        { id: 'now', label: 'Now', open: can('dashboard'), render: () => <Dashboard /> },
        { id: 'close', label: 'Close the day', open: can('close_day'), render: () => <CloseDayPage money={money} /> },
      ]}
    />
  );
}

/** Products: what is sold, the categories it sits in, and the choices added to a dish. */
export function ProductsHub() {
  const can = useCan();
  const anySide = useAnySide();
  return (
    <Hub
      title="Products"
      tabs={[
        { id: 'items', label: 'Items', open: anySide('/catalogue/items'), render: () => <CataloguePage kind="items" /> },
        { id: 'categories', label: 'Categories', open: anySide('/catalogue/categories'), render: () => <CataloguePage kind="categories" /> },
        { id: 'options', label: 'Options', open: can('menu_options'), render: () => <AddonsPage /> },
      ]}
    />
  );
}

export function CustomersHub() {
  const can = useCan();
  return (
    <Hub
      title="Customers"
      tabs={[
        { id: 'people', label: 'People', open: can('customers'), render: () => <CustomersPage /> },
        { id: 'tabs', label: 'Tabs', open: can('tabs'), render: () => <TabsPage /> },
      ]}
    />
  );
}

export function MakersHub() {
  const can = useCan();
  return (
    <Hub
      title="Makers"
      tabs={[
        { id: 'makers', label: 'Makers', open: can('consignors'), render: () => <ConsignorsPage /> },
        { id: 'received', label: 'Goods received', open: can('intake'), render: () => <IntakePage /> },
        { id: 'payouts', label: 'Payouts', open: can('payouts'), render: () => <PayoutsPage /> },
      ]}
    />
  );
}

export function ShiftsHub() {
  const can = useCan();
  return (
    <Hub
      title="Shifts"
      tabs={[
        { id: 'shifts', label: 'Shifts', open: can('shifts'), render: () => <ShiftsPage /> },
        { id: 'owing', label: 'Staff owing', open: can('staff_owing'), render: () => <StaffOwingPage /> },
      ]}
    />
  );
}

/**
 * Every report in one place: the sales, and the statements from the books.
 *
 * The statements were a row of Accounting called Reports, beside a page
 * called Reports. They show here only to people given them, as before.
 */
export function ReportsHub() {
  const { profile, settings } = useSession();
  const can = useCan();
  const books = bookAreas('reports', profile, settings);
  const book = (id: BookTab, label: string) => ({
    id, label, open: books.includes(id), group: 'books',
    render: () => <AccountingPage set="reports" only={id} />,
  });
  return (
    <Hub
      title="Reports"
      tabs={[
        // One screen for the three, so the dates chosen on one hold on the next.
        { id: 'sales', label: 'Sales', open: can('reports'), group: 'sales', render: () => <ReportsPage view="sales" /> },
        { id: 'trends', label: 'Trends', open: can('reports'), group: 'sales', render: () => <ReportsPage view="trends" /> },
        { id: 'dishes', label: 'Dishes', open: can('reports'), group: 'sales', render: () => <ReportsPage view="dishes" /> },
        book('statements', 'Profit & loss'),
        book('cashflow', 'Cash flow'),
        book('tax', 'Tax return'),
      ]}
    />
  );
}

export function VenuesHub() {
  const can = useCan();
  return (
    <Hub
      title="Venues"
      tabs={[
        { id: 'venues', label: 'Venues & hours', open: can('venues'), render: () => <VenuesPage /> },
        { id: 'tables', label: 'Tables & QR', open: can('tables'), render: () => <TablesPage /> },
        { id: 'stations', label: 'Kitchen stations', open: can('stations'), render: () => <StationsPage /> },
      ]}
    />
  );
}

/** Settings: what the business runs, how, and the owner's tools for its records. */
export function SettingsHub() {
  const can = useCan();
  const part = (id: SettingsSection, label: string) => ({
    id, label, open: can('settings'), group: 'settings', render: () => <SettingsPage section={id} />,
  });
  return (
    <Hub
      title="Settings"
      tabs={[
        { id: 'features', label: 'Features', open: can('features'), render: () => <FeaturesPage /> },
        part('business', 'Business'),
        part('money', 'Money'),
        part('shifts', 'Shifts & counts'),
        part('kitchen', 'Kitchen'),
        part('email', 'Email & backups'),
        { id: 'data', label: 'Data', open: can('health') || can('erase'), render: () => <DataTab /> },
      ]}
    />
  );
}

/** Health and erasing records: both owner-only, both seldom opened, one tab. */
function DataTab() {
  const can = useCan();
  return (
    <>
      <h1><HubTitle>Data</HubTitle></h1>
      <HubTabs />
      {can('health') && <HealthPage asSection />}
      {can('health') && can('erase') && <div style={{ height: '2rem' }} />}
      {can('erase') && <PurgePage asSection />}
    </>
  );
}

export function StaffHub() {
  const can = useCan();
  return (
    <Hub
      title="Staff"
      tabs={[
        { id: 'people', label: 'People', open: can('staff'), render: () => <StaffPage /> },
        // Who can open what. Still behind the settings grant it had.
        { id: 'permissions', label: 'Permissions', open: can('settings'), render: () => <SettingsPage section="permissions" /> },
      ]}
    />
  );
}
