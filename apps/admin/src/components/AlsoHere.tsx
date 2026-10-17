import { Link } from 'react-router-dom';
import { ADMIN_SECTIONS, canOpen } from '@snpos/core';
import { useSession } from '../session';

/**
 * Links to the pages this one hosts: the ones left out of the sidebar
 * because they are reached from here (see `under` in access.ts). Only the
 * ones this person may open.
 */
export function AlsoHere({ host }: { host: string }) {
  const { profile, settings } = useSession();
  const pages = ADMIN_SECTIONS.filter((s) => s.under === host && canOpen(s.key, profile, settings));
  if (pages.length === 0) return null;
  return (
    <div className="row row-wrap" style={{ gap: '0.5rem', margin: '0 0 0.8rem' }}>
      {pages.map((s) => <Link key={s.key} className="btn btn-sm" to={s.path}>{s.label}</Link>)}
    </div>
  );
}
