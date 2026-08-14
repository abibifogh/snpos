import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, useToast } from '@snpos/ui';
import { db, DB_ID, ID, Query, listAll, humanError } from '../lib';
import { isSystemAccount } from '@snpos/core';
import type { Doc } from '@snpos/core';
import { useSession } from '../session';

export interface AccountRow extends Doc {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  parent_code?: string;
  system?: boolean;
  /** Retired. Missing means active: the flag arrived after the accounts did. */
  active?: boolean;
}

const TYPES: AccountRow['type'][] = ['expense', 'revenue', 'asset', 'liability', 'equity'];

const TYPE_HELP: Record<AccountRow['type'], string> = {
  expense: 'Money going out, supplies, rent, transport, wages.',
  revenue: 'Money coming in from selling.',
  asset: 'Something the business holds, cash, stock, money owed to you.',
  liability: 'Something the business owes, tax collected, tips not yet paid out.',
  equity: "The owner's stake.",
};

/**
 * Suggest the next free code in the right range.
 *
 * The ranges are the ordinary accounting convention, 1000s assets, 4000s
 * revenue, 6000s expenses, and following it means the Reports page lists
 * things in a sensible order without anybody having to think about numbering.
 * An admin who wants a different number can type one.
 */
const START: Record<AccountRow['type'], number> = {
  asset: 1000, liability: 2000, equity: 3000, revenue: 4000, expense: 6000,
};
function suggestCode(type: AccountRow['type'], existing: AccountRow[]): string {
  const taken = new Set(existing.map((a) => a.code));
  for (let n = START[type]; n < START[type] + 990; n += 10) {
    if (!taken.has(String(n))) return String(n);
  }
  return '';
}

/**
 * The restaurant's chart of accounts.
 *
 * The list every expense category points at, and the list Reports groups by.
 * It was seeded once and then unreachable, which meant a restaurant whose real
 * outgoings are gas refills, okada runs and landlord rent had to file all
 * three under "Other expenses" and read a report that said nothing.
 *
 * Ten of these accounts are written to by the system itself at shift close, 
 * cash, sales, tax, tips. Those can be renamed to suit the house but never
 * removed or re-typed, because a posting names them by number and a missing
 * one would surface as a shift that will not close.
 */
export function AccountsManager() {
  const toast = useToast();
  // Appwrite lets a manager read the chart but only an admin change it. Showing
  // buttons that answer with a permission error is worse than not showing them.
  const canEdit = useSession().profile?.role === 'admin';
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [editing, setEditing] = useState<Partial<AccountRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const load = () =>
    listAll<AccountRow>('accounts')
      .then((r) => setRows(r.sort((a, b) => a.code.localeCompare(b.code))))
      .catch((e) => setError(humanError(e)));
  useEffect(() => { void load(); }, []);

  const open = (a?: AccountRow) => {
    setEditing(a ?? { code: '', name: '', type: 'expense' });
    setError(null);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setError('Give the account a name.'); return; }
    const type = editing.type ?? 'expense';
    const code = (editing.code ?? '').trim() || suggestCode(type, rows ?? []);
    if (!/^[0-9]{3,10}$/.test(code)) { setError('The code should be a number, for example 6100.'); return; }
    if (!editing.$id && (rows ?? []).some((a) => a.code === code)) {
      setError(`${code} is already in use by "${(rows ?? []).find((a) => a.code === code)?.name}".`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (editing.$id) {
        // The code is frozen once created. Every posting ever made refers to it
        // by number, so changing it would not move that history, it would
        // orphan it, silently, and only show up as a report that no longer adds
        // up. Renaming is always safe.
        await db.updateDocument(DB_ID, 'accounts', editing.$id, {
          name: editing.name.trim(),
          ...(isSystemAccount(editing.code ?? '') ? {} : { type }),
        });
      } else {
        await db.createDocument(DB_ID, 'accounts', ID.unique(), {
          code,
          name: editing.name.trim(),
          type,
          system: false,
        });
      }
      setEditing(null);
      await load();
      toast('Saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Stop using an account without losing what was posted to it.
   *
   * The honest end of an account's life, and for most of them the only one
   * available: the moment money has been posted to it, deleting it is refused
   * below, because the postings are what make last month's figures readable
   * and taking the account away turns them into a row of bare numbers.
   *
   * So archiving does exactly one thing — it takes the account off every list
   * that offers a choice. It stays on the trial balance, on the profit and
   * loss, and behind every figure that drills down to it. A restaurant that
   * stopped using "Okada runs" in March should still see March's okada runs.
   *
   * Built-in accounts are excluded. The system posts to those by code when a
   * shift closes, so an archived one would surface as a shift that will not
   * close, which is a bad way to find out.
   */
  const archive = async (a: AccountRow, active: boolean) => {
    if (isSystemAccount(a.code)) return;
    try {
      await db.updateDocument(DB_ID, 'accounts', a.$id, { active });
      await load();
      toast(active ? `${a.name} is back in use` : `${a.name} archived`);
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const remove = async (a: AccountRow) => {
    if (isSystemAccount(a.code)) return;
    try {
      // Nothing is deleted out from under history. An account with postings
      // behind it is what makes an old report readable; removing it would turn
      // last month's figures into a row of bare numbers. Archiving is the way
      // out of that, and is offered by name rather than left to be guessed at.
      const [posted, used] = await Promise.all([
        db.listDocuments(DB_ID, 'journal_lines', [Query.equal('account_code', a.code), Query.limit(1)]),
        listAll<{ name: string; account_code?: string }>('expense_categories'),
      ]);
      if (posted.total > 0) {
        toast(`${a.name} already has money posted to it, so it cannot be deleted. Archive it instead — it comes off the lists and stays on the reports.`, 'err');
        return;
      }
      const pointing = used.filter((c) => c.account_code === a.code).map((c) => c.name);
      if (pointing.length) {
        toast(`Point ${pointing.join(', ')} somewhere else first, ${pointing.length === 1 ? 'it posts' : 'they post'} to this account.`, 'err');
        return;
      }
      if (!confirm(`Remove ${a.code} ${a.name}?`)) return;
      await db.deleteDocument(DB_ID, 'accounts', a.$id);
      await load();
      toast('Removed');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const archivedCount = (rows ?? []).filter((a) => a.active === false).length;
  const shown = (rows ?? []).filter((a) => showArchived || a.active !== false);

  return (
    <>
      <div className="spread">
        <p className="dim small" style={{ marginTop: 0, maxWidth: '46rem' }}>
          The lines your money lands on. Expense categories point at one of these, and Reports adds up by them, so
          this is what decides whether your report says “GH₵4,200 other” or “GH₵2,800 gas, GH₵1,400 transport”.
          Add whatever your outgoings actually are. One you have stopped using can be archived: it comes off every
          list you choose from, and stays on every report it already appears in.
        </p>
        <div className="row" style={{ gap: '0.5rem' }}>
          {archivedCount > 0 && (
            <Button size="sm" onClick={() => setShowArchived((s) => !s)}>
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </Button>
          )}
          {canEdit && <Button variant="primary" onClick={() => open()}>Add account</Button>}
        </div>
      </div>

      {error && !editing && <Notice>{error}</Notice>}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : shown.length === 0 ? (
          <Empty title={rows.length === 0 ? 'No accounts yet' : 'All archived'}>
            {rows.length === 0
              ? 'Run Provision Appwrite to seed the standard set, or add your own.'
              : 'Every account here has been archived. Show archived to bring one back.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Code</th><th>Name</th><th>Kind</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const locked = isSystemAccount(a.code);
                  const archived = a.active === false;
                  return (
                    <tr key={a.$id} className={archived ? 'dim' : undefined}>
                      <td className="dim">{a.code}</td>
                      <td>
                        {a.name}
                        {locked && <Badge> built in</Badge>}
                        {archived && <Badge tone="warn"> archived</Badge>}
                      </td>
                      <td className="dim">{a.type}</td>
                      <td className="num">
                        {canEdit && <Button size="sm" variant="ghost" onClick={() => open(a)}>Edit</Button>}
                        {canEdit && !locked && (
                          <Button size="sm" variant="ghost" onClick={() => archive(a, archived)}>
                            {archived ? 'Use again' : 'Archive'}
                          </Button>
                        )}
                        {canEdit && !locked && (
                          <Button size="sm" variant="ghost" onClick={() => remove(a)}>Remove</Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.code}` : 'Add account'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

          {editing.$id && isSystemAccount(editing.code ?? '') && (
            <Notice>
              The system posts to this account by itself when a shift closes. You can rename it to suit the house, but
              its code and kind have to stay as they are.
            </Notice>
          )}

          <Field label="Name">
            <Input
              value={editing.name ?? ''}
              autoFocus
              placeholder="Gas, Rent, Okada runs…"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </Field>

          <div className="grid-2">
            <Field
              label="Kind"
              hint={TYPE_HELP[editing.type ?? 'expense']}
            >
              <Select
                value={editing.type ?? 'expense'}
                disabled={!!editing.$id}
                onChange={(e) => {
                  const type = e.target.value as AccountRow['type'];
                  setEditing((c) => ({
                    ...c,
                    type,
                    // Only while it is still a suggestion. A code somebody has
                    // typed deliberately is not moved out from under them.
                    code: c?.$id ? c.code : suggestCode(type, rows ?? []),
                  }));
                }}
              >
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
            <Field
              label="Code"
              hint={editing.$id ? 'Fixed, every posting made refers to it.' : 'A number. The suggestion is fine.'}
            >
              <Input
                value={editing.code ?? ''}
                disabled={!!editing.$id}
                inputMode="numeric"
                placeholder={suggestCode(editing.type ?? 'expense', rows ?? [])}
                onChange={(e) => setEditing({ ...editing, code: e.target.value.replace(/\D/g, '') })}
              />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
