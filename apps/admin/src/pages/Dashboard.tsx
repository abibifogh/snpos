import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Badge, Spinner } from '@snpos/ui';
import { listAll } from '../lib';
import { useSession } from '../session';
import type { Category, MenuItem, Venue } from '@snpos/core';

export function Dashboard() {
  const { settings } = useSession();
  const [counts, setCounts] = useState<{ categories: number; items: number; venues: number } | null>(null);

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

  return (
    <>
      <h1>Dashboard</h1>

      <Card title="Getting started">
        <p className="small dim" style={{ marginTop: 0 }}>
          The database is set up. Work down this list and the customer menu will have something to show.
        </p>
        <ol className="small" style={{ lineHeight: 1.9, paddingLeft: '1.2rem', margin: 0 }}>
          <li>
            <Link to="/settings">Settings</Link> — restaurant name, currency, tax and colours.
          </li>
          <li>
            <Link to="/venues">Venues</Link> — set your opening hours. Pre-ordering needs these.
          </li>
          <li>
            <Link to="/menu/categories">Categories</Link> — Starters, Mains, Drinks.
          </li>
          <li>
            <Link to="/menu/items">Dishes &amp; drinks</Link> — the menu itself, with prices.
          </li>
          <li>
            <Link to="/features">Features</Link> — switch off anything you do not want yet.
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
