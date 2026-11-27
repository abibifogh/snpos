import { useSearchParams } from 'react-router-dom';
import { ViewTabs } from '@snpos/ui';
import { canOpen, bookAreas, NAV_MERGES, BOOK_PAGES } from '@snpos/core';
import type { BookPage } from '@snpos/core';
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
import { VouchersPage } from './Vouchers';
import { CountPage } from './Count';
import { CountLogPage } from './CountLog';
import { FollowUpsPage } from './FollowUps';
import { WaitingPage } from './Waiting';
import { GroupBookingsPage } from './GroupBookings';
import { DeductionsHivePage, HiveMatchingPage, PreordersPage } from './ChecksTabs';
import { DifferencesReview, ClosedDifferences, DifferencesWaiting } from '../components/CountDifferences';

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
        // Beside the prices it changes; it was a link of its own.
        { id: 'discounts', label: 'Discounts', open: can('vouchers'), render: () => <VouchersPage /> },
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
      ]}
    />
  );
}

/**
 * To do: everything waiting on somebody. What to decide (what Approvals
 * was), what to chase (follow-ups with a due day), and what was done this
 * week. An auditor decides only count differences, so theirs is that line.
 */
export function TodoHub() {
  const { profile } = useSession();
  const can = useCan();
  const chase = can('waiting') || can('differences');
  return (
    <Hub
      title="To do"
      tabs={[
        {
          id: 'decide',
          label: 'To decide',
          open: can('waiting'),
          render: () => (profile?.role === 'auditor' ? <AuditorDecide /> : <WaitingPage />),
        },
        { id: 'follow', label: 'To follow up', open: chase, group: 'follow', render: () => <FollowUpsPage view="open" /> },
        { id: 'done', label: 'Done this week', open: chase, group: 'follow', render: () => <FollowUpsPage view="done" /> },
      ]}
    />
  );
}

function AuditorDecide() {
  return (
    <>
      <h1><HubTitle>To decide</HubTitle></h1>
      <HubTabs />
      <DifferencesWaiting />
      <p className="small dim">
        Counts, spends and orders waiting for approval are decided by an admin or a manager. Count differences are
        yours to decide up to your limit; above it, you recommend.
      </p>
    </>
  );
}

/** Counts: every count filed, the sheet to count on, and the counts nobody filed. */
export function CountsHub() {
  const { profile } = useSession();
  const anySide = useAnySide();
  const sides = anySide('/counts');
  return (
    <Hub
      title="Counts"
      tabs={[
        { id: 'log', label: 'Count log', open: sides, render: () => <CountLogPage view="log" /> },
        // Never for an auditor: the person checking the counts does not take them.
        { id: 'count', label: 'Count now', open: sides && profile?.role !== 'auditor', render: () => <CountPage /> },
        { id: 'missed', label: 'Missed counts', open: sides, render: () => <CountLogPage view="missed" /> },
      ]}
    />
  );
}

/** Differences: from the count that found it to the deduction that goes to HIVE. */
export function DifferencesHub() {
  const can = useCan();
  return (
    <Hub
      title="Differences"
      tabs={[
        { id: 'review', label: 'To review', open: can('differences'), render: () => <DifferencesReview /> },
        { id: 'owing', label: 'Owing', open: can('staff_owing'), render: () => <StaffOwingPage /> },
        { id: 'hive', label: 'Deductions & HIVE', open: can('staff_owing') || can('differences'), render: () => <DeductionsHivePage /> },
        { id: 'closed', label: 'Closed', open: can('differences'), render: () => <ClosedDifferences /> },
      ]}
    />
  );
}

/** Bookings: food somebody has booked, one by one or as a party. */
export function BookingsHub() {
  const can = useCan();
  return (
    <Hub
      title="Bookings"
      tabs={[
        { id: 'preorders', label: 'Pre-orders', open: can('group_bookings') || can('orders'), render: () => <PreordersPage /> },
        { id: 'groups', label: 'Group bookings', open: can('group_bookings'), render: () => <GroupBookingsPage /> },
      ]}
    />
  );
}

/**
 * Accounting: the weekly jobs and the accountant's tools, one link with a
 * switch between them. The part of the books in the address decides which
 * side is shown, so every old link to either lands on the right one.
 */
export function AccountingHub() {
  const { profile, settings } = useSession();
  const [params, setParams] = useSearchParams();
  const jobs = bookAreas('jobs', profile, settings);
  const tools = bookAreas('accountant', profile, settings);
  const tab = params.get('tab');
  const inSet = (set: BookPage) => !!tab && (BOOK_PAGES[set] as readonly string[]).includes(tab);
  const set: BookPage = inSet('accountant') ? 'accountant'
    : inSet('jobs') ? 'jobs'
      : params.get('set') === 'accountant' && tools.length ? 'accountant'
        : jobs.length || !tools.length ? 'jobs' : 'accountant';
  const both = jobs.length > 0 && tools.length > 0;
  return (
    <AccountingPage
      key={set}
      set={set}
      switcher={both ? (
        <ViewTabs<BookPage>
          value={set}
          onChange={(s) => setParams({ tab: (s === 'jobs' ? jobs : tools)[0] ?? '' })}
          ariaLabel="Which part of the books"
          options={[{ value: 'jobs', label: 'Day to day' }, { value: 'accountant', label: 'Accountant tools' }]}
        />
      ) : null}
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
        { id: 'permissions', label: 'Roles & permissions', open: can('settings'), render: () => <SettingsPage section="permissions" /> },
        // Each person matched once to HIVE, the payroll. Was at the foot of People.
        { id: 'hive', label: 'HIVE matching', open: can('staff'), render: () => <HiveMatchingPage /> },
      ]}
    />
  );
}
