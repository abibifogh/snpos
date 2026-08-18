import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Badge, Spinner, Notice } from '@snpos/ui';
import { listAll } from '../lib';
import { anyExists, Query } from '@snpos/core';
import { useSession } from '../session';
import type { Category, MenuItem, Venue } from '@snpos/core';

export function Dashboard() {
  const { settings } = useSession();
  const [counts, setCounts] = useState<{ categories: number; items: number; venues: number } | null>(null);
  const [jobsAlive, setJobsAlive] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const [categories, items, venues] = await Promise.all([
        listAll<Category>('categories'),
        listAll<MenuItem>('menu_items'),
        listAll<Venue>('venues'),
      ]);
      setCounts({ categories: categories.length, items: items.length, venues: venues.length });
    })().catch(() => setCounts({ categories: 0, items: 0, venues: 0 }));
  }, []);

  /**
   * Are the background jobs actually running?
   *
   * They are deployed by a separate step that is easy to skip, and when they
   * are missing nothing errors, emails simply never arrive and pre-orders
   * never reach the kitchen. Silence that looks like success is the worst
   * failure mode there is, so it gets checked and said out loud.
   *
   * The test: settled orders exist, but not one has produced a receipt row.
   * The email function writes that row before it tries to send, so its absence
   * means the function never ran at all, as distinct from running and failing
   * to send, which shows up in Reports with a reason.
   */
  /*
    One row each, not three whole tables.

    This asks a yes-or-no question — has anything the background jobs write
    ever appeared — and it was answering it by reading every order, every
    receipt and every notice ever written, on every visit to the dashboard.
    The answer was `.length > 0`.
  */
  useEffect(() => {
    (async () => {
      const settled = await anyExists('orders', [Query.equal('payment_status', 'paid')]);
      if (!settled.any) { setJobsAlive(null); return; }
      const [receipts, notices] = await Promise.all([
        anyExists('receipts').catch(() => ({ any: false, total: 0 })),
        anyExists('order_notices').catch(() => ({ any: false, total: 0 })),
      ]);
      setJobsAlive(receipts.any || notices.any);
    })().catch(() => setJobsAlive(null));
  }, []);

  return (
    <>
      <h1>Dashboard</h1>

      {jobsAlive === false && (
        <Notice>
          <strong>The background jobs are not running.</strong> Bills have been settled but not one has produced a
          receipt record, which means the email job has never run. Nothing on the tills is affected, but emails will
          not send and pre-orders will not reach the kitchen at their time.
          <br />
          <br />
          Fix: GitHub → <strong>Actions</strong> → <strong>Deploy functions</strong> → Run workflow, and type{' '}
          <code>deploy</code>. This is a separate step from Deploy and is easy to miss.
        </Notice>
      )}

      <Card title="Getting started">
        <p className="small dim" style={{ marginTop: 0 }}>
          The database is set up. Work down this list and the customer menu will have something to show.
        </p>
        <ol className="small" style={{ lineHeight: 1.9, paddingLeft: '1.2rem', margin: 0 }}>
          <li>
            <Link to="/settings">Settings</Link>, restaurant name, currency, tax and colours.
          </li>
          <li>
            <Link to="/venues">Venues</Link>, set your opening hours. Pre-ordering needs these.
          </li>
          <li>
            <Link to="/menu/categories">Categories</Link>, Starters, Mains, Drinks.
          </li>
          <li>
            <Link to="/menu/items">Dishes &amp; drinks</Link>, the menu itself, with prices.
          </li>
          <li>
            <Link to="/features">Features</Link>, switch off anything you do not want yet.
          </li>
        </ol>
      </Card>

      <div className="grid-2">
        <Card title="Menu">
          {counts ? (
            <p style={{ margin: 0 }}>
              <strong style={{ fontSize: '1.6rem' }}>{counts.items}</strong>{' '}
              <span className="dim">items across {counts.categories} categories</span>
            </p>
          ) : (
            <Spinner />
          )}
        </Card>
        <Card title="Venues">
          {counts ? (
            <p style={{ margin: 0 }}>
              <strong style={{ fontSize: '1.6rem' }}>{counts.venues}</strong> <span className="dim">configured</span>
            </p>
          ) : (
            <Spinner />
          )}
        </Card>
      </div>

      <Card title="Storage">
        <p className="small" style={{ margin: 0 }}>
          {settings?.storage_mode === 'single' ? (
            <>
              <Badge tone="warn">Shared bucket</Badge>{' '}
              All files share <code>{settings.shared_bucket_id}</code> because the Appwrite plan allows one bucket.
              Uploads carry their own permissions, so receipts stay private. Upgrading the plan and re-running
              provisioning restores separate buckets.
            </>
          ) : (
            <>
              <Badge tone="ok">Separate buckets</Badge> Menu images, branding and receipts are isolated.
            </>
          )}
        </p>
      </Card>
    </>
  );
}
