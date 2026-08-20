import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, useToast,
  ExpenseModal,
} from '@snpos/ui';
import { humanError } from '../lib';
import {
  formatMoney, parseMoney, toInput, saveDropping,
  loadFloats, loadMovements, loadCounts, balancesFor, accountFor,
  topUpFloat, returnFromFloat, reconcileFloat,
  boxBalance, countBox, healthOf, topUpNeeded, overBy, countProblem, withoutReceipt,
  movementsSince, movementsFor, latestCount,
  boxesFor, canFundBoxes, holdsBox, NO_BOX_HELD,
  needsExplaining, IMPREST_KIND_LABELS, loadPaidToOptions, loadAccounts, ACCOUNTS,
  uploadFile, downloadUrl, listByIds, saveDropping as saveRow,
} from '@snpos/core';
import type {
  ImprestFloatDoc, ImprestMovementDoc, ImprestCountDoc, StaffProfile,
  AccountRow, ImprestHealth, Module, Settings,
} from '@snpos/core';
import { useSession } from '../session';

/**
 * Petty cash, run properly.
 *
 * A box is set at a fixed amount, spent against receipts, and topped back up
 * by exactly what was spent — so cash in the box plus receipts held always
 * comes to the fixed amount. That identity is the whole point: it is what
 * makes a tin of money checkable at all. An ordinary float has no such
 * property, and a shortage in one can only be noticed by somebody who happens
 * to remember what was in there last week.
 *
 * Before this, "from petty cash" at the till meant one thing only: do not take
 * this off my drawer. The money really did come from somewhere, and none of it
 * reached any record of that somewhere. The box was spent down all week and
 * only its custodian knew.
 */

const HEALTH_TONE: Record<ImprestHealth, 'ok' | 'warn' | 'danger'> = {
  ok: 'ok', low: 'warn', empty: 'danger', over: 'warn',
};

const HEALTH_WORDS: Record<ImprestHealth, string> = {
  ok: 'Funded', low: 'Running low', empty: 'Empty', over: 'Over its level',
};

export function ImprestPage() {
  const { settings, profile, user } = useSession();
  const toast = useToast();
  const userId = user?.$id ?? '';
  /**
   * Whether this person may fund a box, or only use one.
   *
   * The one real control the imprest system has. See canFundBoxes: somebody
   * who could record their own top-ups could cover a shortage on paper, and no
   * count would ever find it.
   */
  const mayFund = canFundBoxes(profile);

  const [floats, setFloats] = useState<ImprestFloatDoc[] | null>(null);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** The box being looked at, with its history. */
  const [openBox, setOpenBox] = useState<ImprestFloatDoc | null>(null);
  const [movements, setMovements] = useState<ImprestMovementDoc[] | null>(null);
  const [counts, setCounts] = useState<ImprestCountDoc[]>([]);

  const [editing, setEditing] = useState<Partial<ImprestFloatDoc> | null>(null);
  const [doing, setDoing] = useState<'top_up' | 'return' | 'count' | null>(null);
  /** Recording a spend, on the till's own form. See ExpenseModal. */
  const [spending, setSpending] = useState(false);
  const [busy, setBusy] = useState(false);

  // Whatever the open action is asking for. One set of boxes rather than four,
  // because only one of these is ever on screen at a time.
  const [amountText, setAmountText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [fromAccount, setFromAccount] = useState<string>(ACCOUNTS.cash);
  const [alsoTopUp, setAlsoTopUp] = useState(true);
  /** Receipts already attached, by the expense they belong to. */
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [attaching, setAttaching] = useState<string | null>(null);

  const decimals = settings?.currency_decimals ?? 2;
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const load = async () => {
    try {
      const all = await loadFloats('main');
      /*
        Only the boxes this person has anything to do with.

        A custodian sees the tin they hold. A list of every box in the building
        with its balance on it is somebody else's business, and a screen
        offering four boxes to a person responsible for one is a screen where
        the wrong one gets counted.
      */
      const rows = boxesFor(profile, all);
      setFloats(rows);
      setBalances(await balancesFor(rows));
    } catch (e) {
      setError(humanError(e));
      setFloats([]);
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    void (async () => {
      const [{ staff: people }, chart] = await Promise.all([
        loadPaidToOptions().catch(() => ({ staff: [] as StaffProfile[], categories: [], suppliers: [] })),
        loadAccounts().catch(() => [] as AccountRow[]),
      ]);
      setStaff(people);
      setAccounts(chart);
    })();
  }, []);

  /** One box's history, read only when somebody opens it. */
  const openDetail = async (box: ImprestFloatDoc) => {
    setOpenBox(box);
    setMovements(null);
    const [m, c] = await Promise.all([
      loadMovements(box.$id).catch(() => [] as ImprestMovementDoc[]),
      loadCounts(box.$id).catch(() => [] as ImprestCountDoc[]),
    ]);
    setMovements(m);
    setCounts(c);

    /*
      The receipts, joined rather than copied.

      A movement points at the expense it came from, and the expense carries
      the file. Storing the file id on both would be one read fewer and one
      more place for the two to disagree about which receipt belongs to which
      spend — and a receipt attached to the wrong expense is worse than none.
    */
    const expenseIds = m.filter((x) => x.ref_type === 'expense' && x.ref_id).map((x) => x.ref_id as string);
    const rows = await listByIds<{ $id: string; receipt_file_id?: string }>(
      'shift_expenses', '$id', expenseIds,
    ).catch(() => []);
    setReceipts(Object.fromEntries(rows.filter((r) => r.receipt_file_id).map((r) => [r.$id, r.receipt_file_id as string])));
  };

  /**
   * What has happened since the box was last counted.
   *
   * A count is a line drawn under everything up to it, and once it is made
   * those movements have been accounted for. Reading them alongside this
   * week's is what made the list useless: a box counted every Friday showed a
   * year of history on one screen, and the six things that had happened since
   * Friday were lost in it.
   */
  const live = useMemo(() => movementsSince(movements ?? [], counts), [movements, counts]);
  const lastCount = useMemo(() => latestCount(counts), [counts]);
  /** Which past count is open, showing what it settled. */
  const [openCount, setOpenCount] = useState<string | null>(null);

  const liveBalance = useMemo(
    () => (movements ? boxBalance(movements) : openBox ? balances[openBox.$id] ?? 0 : 0),
    [movements, openBox, balances],
  );

  const nameOf = (id?: string) => staff.find((s) => s.$id === id || s.user_id === id)?.display_name ?? '';

  /* ------------------------------------------------------------ the box itself */

  const saveBox = async () => {
    if (!editing) return;
    const name = (editing.name ?? '').trim();
    if (!name) { setError('Give the box a name — whose it is, or where it lives.'); return; }
    const fixed = parseMoney(String(editing.fixed_amount ?? ''), decimals);
    if (fixed === null || fixed <= 0) {
      setError('Set what the box holds when it is full. That fixed amount is what makes it checkable.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveDropping('imprest_floats', editing.$id ?? null, {
        venue_id: 'main',
        name,
        fixed_amount: fixed,
        account_code: editing.account_code || ACCOUNTS.pettyCash,
        custodian_id: editing.custodian_id ?? '',
        module: editing.module ?? '',
        note: (editing.note ?? '').slice(0, 500),
        active: editing.active !== false,
        sort: editing.sort ?? 0,
      });
      setEditing(null);
      await load();
      toast(editing.$id ? 'Box saved' : 'Box added. Top it up to put money in it.');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /* -------------------------------------------------------------- the actions */

  const startDoing = (what: typeof doing) => {
    setDoing(what);
    setError(null);
    setNoteText('');
    setAlsoTopUp(true);
    setFromAccount(ACCOUNTS.cash);
    // The top-up box starts at what it would take to fill it, because that is
    // the answer nine times in ten and retyping it is where it gets typed
    // wrongly. Everything else starts empty: a pre-filled amount on a count is
    // the system telling somebody what they should have found.
    setAmountText(
      what === 'top_up' && openBox ? toInput(topUpNeeded(openBox.fixed_amount, liveBalance), decimals) : '',
    );
  };

  const runAction = async () => {
    if (!openBox || !doing) return;
    const amount = parseMoney(amountText, decimals);

    if (doing === 'count') {
      const problem = countProblem(amountText);
      if (problem) { setError(problem); return; }
    } else if (amount === null || amount <= 0) {
      setError('Enter an amount.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (doing === 'top_up') {
        await topUpFloat({
          venueId: 'main', box: openBox, amount: amount ?? 0, userId, fromAccount, note: noteText.trim(),
        });
        toast(`${money(amount ?? 0)} into ${openBox.name}`);
      } else if (doing === 'return') {
        await returnFromFloat({
          venueId: 'main', box: openBox, amount: amount ?? 0, userId, toAccount: fromAccount, note: noteText.trim(),
        });
        toast(`${money(amount ?? 0)} back out of ${openBox.name}`);
      } else if (doing === 'count') {
        const result = await reconcileFloat({
          venueId: 'main',
          box: openBox,
          counted: amount ?? 0,
          userId,
          note: noteText.trim(),
          topUp: alsoTopUp,
        });
        toast(
          result.variance === 0
            ? `${openBox.name} counted, and it balances.`
            : result.variance < 0
              ? `${openBox.name} is ${money(Math.abs(result.variance))} short. Posted to cash over / short.`
              : `${openBox.name} is ${money(result.variance)} over. Posted to cash over / short.`,
          result.variance === 0 ? 'ok' : 'err',
        );
        if (result.toppedUp > 0) toast(`${money(result.toppedUp)} put back to bring it up to its level.`);
      }

      setDoing(null);
      await load();
      await openDetail(openBox);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------------ drawing */

  const counting = doing === 'count';
  const countPreview = openBox && counting
    ? countBox({
        fixedAmount: openBox.fixed_amount,
        balance: liveBalance,
        counted: parseMoney(amountText, decimals) ?? 0,
      })
    : null;

  if (!floats) return <Card><Spinner /></Card>;

  return (
    <>
      <div className="spread">
        <h1>Petty cash</h1>
        {mayFund && (
          <Button variant="primary" onClick={() => { setEditing({ active: true }); setError(null); }}>
            Add a box
          </Button>
        )}
      </div>

      {error && !editing && !doing && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {floats.length === 0 && !mayFund ? (
        <Card>
          <Empty title="No box is assigned to you">{NO_BOX_HELD}</Empty>
        </Card>
      ) : floats.length === 0 ? (
        <Card>
          <Empty title="No petty cash box yet">
            A box is a fixed amount of cash somebody holds for small spending — market runs, a taxi, a gas
            refill. Set the amount it holds when full, and it can be spent from, counted and topped back up.
            Until there is one, choosing &ldquo;from petty cash&rdquo; at a till only means &ldquo;do not take
            this off my drawer&rdquo;, and the money it came from is recorded nowhere.
          </Empty>
        </Card>
      ) : (
        <Card pad={false}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Box</th>
                  <th>Held by</th>
                  <th className="num">In it now</th>
                  <th className="num">When full</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {floats.map((f) => {
                  const balance = balances[f.$id] ?? 0;
                  const health = healthOf(f.fixed_amount, balance);
                  return (
                    <tr key={f.$id} style={{ opacity: f.active === false ? 0.55 : 1 }}>
                      <td style={{ fontWeight: 550 }}>
                        {f.name}
                        {f.active === false && <> <Badge>Retired</Badge></>}
                        {f.module && <div className="small dim">{f.module}</div>}
                      </td>
                      <td className="dim small">
                        {holdsBox(profile, f) ? 'You' : nameOf(f.custodian_id) || <span className="dim">Nobody</span>}
                      </td>
                      <td className="num" style={{ fontWeight: 650 }}>{money(balance)}</td>
                      <td className="num dim">{money(f.fixed_amount)}</td>
                      <td>
                        <Badge tone={HEALTH_TONE[health]}>{HEALTH_WORDS[health]}</Badge>
                        {topUpNeeded(f.fixed_amount, balance) > 0 && (
                          <div className="small dim">{money(topUpNeeded(f.fixed_amount, balance))} to fill</div>
                        )}
                        {overBy(f.fixed_amount, balance) > 0 && (
                          <div className="small dim">{money(overBy(f.fixed_amount, balance))} above its level</div>
                        )}
                      </td>
                      <td className="right">
                        <Button size="sm" onClick={() => void openDetail(f)}>Open</Button>
                        {mayFund && (
                          <Button size="sm" variant="ghost" onClick={() => { setEditing(f); setError(null); }}>
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {floats.length > 0 && (
        <Card title="How this works">
          <p className="small dim" style={{ marginTop: 0 }}>
            The box is set at a fixed amount. Money is spent out of it against receipts, and it is topped back
            up by exactly what was spent — so what is in the box plus what has been spent since always comes to
            the fixed amount. That is what makes it checkable: count the tin, and anything that does not add up
            is visible the same day rather than at the end of a month nobody can reconstruct.
          </p>
          <p className="small dim" style={{ marginBottom: 0 }}>
            Every spend from a box lands in the accounts the same way any other expense does, under whichever
            account its category points at — and it is credited against the box rather than the till, so a
            drawer is never counted short for money that is sitting in a tin.
          </p>
        </Card>
      )}

      {/* ------------------------------------------------------------- one box */}

      {openBox && (
        <Modal title={openBox.name} wide onClose={() => { setOpenBox(null); setDoing(null); }}>
          <div className="row row-wrap" style={{ gap: '1.6rem', alignItems: 'flex-end' }}>
            <div>
              <div className="dim small">In it now</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{money(liveBalance)}</div>
            </div>
            <div>
              <div className="dim small">When full</div>
              <div style={{ fontSize: '1.2rem' }}>{money(openBox.fixed_amount)}</div>
            </div>
            <div>
              <div className="dim small">Held by</div>
              <div style={{ fontSize: '1.2rem' }}>{nameOf(openBox.custodian_id) || 'Nobody named'}</div>
            </div>
            <div>
              <div className="dim small">Sits in</div>
              <div className="small">{accountFor(openBox)}</div>
            </div>
          </div>

          {counts[0] && (
            <p className="small dim" style={{ marginTop: '0.8rem' }}>
              Last counted {new Date(counts[0].counted_at ?? counts[0].$createdAt).toLocaleDateString()}
              {counts[0].variance === 0
                ? ' and it balanced.'
                : counts[0].variance < 0
                  ? `, ${money(Math.abs(counts[0].variance))} short.`
                  : `, ${money(counts[0].variance)} over.`}
            </p>
          )}

          {!mayFund && (
            <p className="small dim" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
              You can spend from this box and count it. Putting money in and taking it out is done by an admin —
              keeping those two apart is what makes the count worth making.
            </p>
          )}

          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', margin: '0.8rem 0' }}>
            <Button variant="primary" onClick={() => startDoing('count')}>Count and reconcile</Button>
            {/* The till's own spend form, opened against this box.

                It already knows how to turn a market run into a list of
                ingredients and put them on the shelf — a second form beside it
                would eventually disagree about how a purchase reaches stock,
                and the shelf is the one thing that cannot survive two
                opinions. */}
            <Button onClick={() => setSpending(true)}>Record a spend</Button>
            {/* Putting money in and taking it out are somebody else's job. See
                canFundBoxes: a custodian who could record their own top-ups
                could cover a shortage on paper. */}
            {mayFund && <Button onClick={() => startDoing('top_up')}>Top up</Button>}
            {mayFund && <Button onClick={() => startDoing('return')}>Take money out</Button>}
          </div>

          {error && doing === null && <Notice>{error}</Notice>}

          {/* Said where somebody counting the box will read it. A box that
              balances with no receipts behind it has proved nothing except
              that somebody can subtract. */}
          {live.length > 0 && withoutReceipt(live, receipts).length > 0 && (
            <Notice tone="warn">
              {withoutReceipt(live, receipts).length}{' '}
              {withoutReceipt(live, receipts).length === 1 ? 'spend has' : 'spends have'} no receipt against
              {withoutReceipt(live, receipts).length === 1 ? ' it' : ' them'}. Attach them from the list
              below — the count tells you the money is gone, and only the receipt says what for.
            </Notice>
          )}

          <h3>{lastCount ? 'Since the last count' : 'Everything that has moved'}</h3>
          {lastCount && (
            <p className="small dim" style={{ marginTop: 0 }}>
              Counted {new Date(lastCount.counted_at ?? lastCount.$createdAt).toLocaleString()}.
              Everything before that is filed under its count below.
            </p>
          )}
          {!movements ? (
            <Spinner />
          ) : live.length === 0 ? (
            <Empty title={lastCount ? 'Nothing since the last count' : 'Nothing yet'}>
              {lastCount
                ? 'The box has not been touched since it was counted. Spend from it or top it up and it will '
                  + 'appear here.'
                : 'Top the box up to put money in it. Until then there is nothing to spend and nothing to count.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th><th>What</th><th>Note</th>
                    <th className="num">In</th><th className="num">Out</th><th>Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((m) => (
                    <tr key={m.$id}>
                      <td className="dim small">
                        {new Date(m.occurred_at ?? m.$createdAt).toLocaleDateString()}
                      </td>
                      <td>{IMPREST_KIND_LABELS[m.kind] ?? m.kind}</td>
                      <td className="small dim">{m.note || '—'}</td>
                      <td className="num">{m.amount > 0 ? money(m.amount) : ''}</td>
                      <td className="num">{m.amount < 0 ? money(-m.amount) : ''}</td>
                      <td className="small">
                        {/* Only a spend has one to show. A top-up is a
                            transfer between two places the business already
                            owns; there is no third party to have issued a
                            receipt for it. */}
                        {m.kind !== 'spend' || !m.ref_id ? (
                          <span className="dim">—</span>
                        ) : receipts[m.ref_id] ? (
                          <a
                            href={downloadUrl(receipts[m.ref_id], 'receipt', settings)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                        ) : (
                          <label className="small" style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                            {attaching === m.ref_id ? 'Attaching…' : 'Attach'}
                            <input
                              type="file"
                              accept="image/*,application/pdf"
                              capture="environment"
                              style={{ display: 'none' }}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                const expenseId = m.ref_id;
                                if (!file || !expenseId) return;
                                if (file.size > 10 * 1024 * 1024) {
                                  toast('That file is over 10MB. Take a smaller photo.', 'err');
                                  return;
                                }
                                void (async () => {
                                  setAttaching(expenseId);
                                  try {
                                    const up = await uploadFile(file, 'receipt', settings);
                                    await saveRow('shift_expenses', expenseId, { receipt_file_id: up.fileId });
                                    setReceipts((r) => ({ ...r, [expenseId]: up.fileId }));
                                    toast('Receipt attached');
                                  } catch (err) {
                                    toast(humanError(err), 'err');
                                  } finally {
                                    setAttaching(null);
                                  }
                                })();
                              }}
                            />
                          </label>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/*
            The counts, each holding what it settled.

            This is where the live list goes when it is cleared: not deleted,
            filed. "What happened during the week the box came up forty short"
            is the question an admin actually has, and it can only be answered
            if the movements stay attached to the count that found it.
          */}
          {counts.length > 0 && (
            <>
              <h3 style={{ marginTop: '1.4rem' }}>Counts</h3>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Counted</th><th>By</th>
                      <th className="num">Expected</th><th className="num">Found</th>
                      <th className="num">Difference</th><th className="num">Put back</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {counts.map((c) => {
                      const covered = movementsFor(movements ?? [], c);
                      const isOpen = openCount === c.$id;
                      return (
                        <Fragment key={c.$id}>
                          <tr>
                            <td className="small">
                              {new Date(c.counted_at ?? c.$createdAt).toLocaleString()}
                              {c.note && <div className="small dim">{c.note}</div>}
                            </td>
                            <td className="dim small">{nameOf(c.counted_by) || '—'}</td>
                            <td className="num dim">{money(c.expected)}</td>
                            <td className="num">{money(c.counted)}</td>
                            <td className="num">
                              {c.variance === 0 ? (
                                <Badge tone="ok">Balanced</Badge>
                              ) : (
                                <Badge tone={c.variance < 0 ? 'danger' : 'warn'}>
                                  {c.variance > 0 ? '+' : ''}{money(c.variance)}
                                </Badge>
                              )}
                            </td>
                            <td className="num dim">{c.topped_up ? money(c.topped_up) : ''}</td>
                            <td className="num">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setOpenCount(isOpen ? null : c.$id)}
                              >
                                {isOpen ? 'Hide' : `${covered.length} ${covered.length === 1 ? 'entry' : 'entries'}`}
                              </Button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={7} style={{ background: 'var(--surface-2, rgba(0,0,0,0.03))' }}>
                                {covered.length === 0 ? (
                                  <p className="small dim" style={{ margin: 0 }}>
                                    Nothing moved between this count and the one before it.
                                  </p>
                                ) : (
                                  <table className="data">
                                    <thead>
                                      <tr>
                                        <th>When</th><th>What</th><th>Note</th>
                                        <th className="num">In</th><th className="num">Out</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {covered.map((m) => (
                                        <tr key={m.$id}>
                                          <td className="dim small">
                                            {new Date(m.occurred_at ?? m.$createdAt).toLocaleDateString()}
                                          </td>
                                          <td>{IMPREST_KIND_LABELS[m.kind] ?? m.kind}</td>
                                          <td className="small dim">{m.note || '—'}</td>
                                          <td className="num">{m.amount > 0 ? money(m.amount) : ''}</td>
                                          <td className="num">{m.amount < 0 ? money(-m.amount) : ''}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* --------------------------------------------------------- the actions */}

      {openBox && doing && (
        <Modal
          title={
            doing === 'count' ? `Count ${openBox.name}`
              : doing === 'top_up' ? `Top up ${openBox.name}`
                : `Take money out of ${openBox.name}`
          }
          onClose={() => setDoing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDoing(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void runAction()} loading={busy}>
                {doing === 'count' ? 'Save the count' : 'Save'}
              </Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

          {counting && (
            <p className="small dim" style={{ marginTop: 0 }}>
              Count what is physically in the box and type it in. The system already knows what it thinks is
              there; typing that figure back in is not a count, and the difference between the two is the only
              thing this screen exists to find.
            </p>
          )}

          <Field
            label={
              counting
                ? `What is actually in the box (${settings?.currency_symbol ?? ''})`
                : `How much (${settings?.currency_symbol ?? ''})`
            }
            hint={
              doing === 'top_up'
                ? `${money(topUpNeeded(openBox.fixed_amount, liveBalance))} would bring it back to its level.`
                : undefined
            }
          >
            <Input value={amountText} inputMode="decimal" onChange={(e) => setAmountText(e.target.value)} />
          </Field>

          {/* The count, worked out as it is typed. Somebody should see what
              they are about to record before they record it, not read it in a
              toast afterwards. */}
          {countPreview && amountText.trim() !== '' && (
            <Notice tone={countPreview.variance === 0 ? 'ok' : needsExplaining(countPreview.variance) ? 'err' : 'warn'}>
              {countPreview.variance === 0 ? (
                <>It balances. {money(countPreview.expected)} expected, {money(countPreview.counted)} counted.</>
              ) : (
                <>
                  <strong>
                    {money(Math.abs(countPreview.variance))} {countPreview.variance < 0 ? 'short' : 'over'}.
                  </strong>
                  {' '}{money(countPreview.expected)} expected, {money(countPreview.counted)} counted. This is
                  posted to cash over / short, the same account a drawer&rsquo;s difference goes to.
                </>
              )}
              {countPreview.toRestore > 0 && (
                <div className="small" style={{ marginTop: '0.3rem' }}>
                  {money(countPreview.toRestore)} would bring it back to its level.
                </div>
              )}
            </Notice>
          )}

          {(doing === 'top_up' || doing === 'return') && (
            <Field
              label={doing === 'top_up' ? 'Where the money came from' : 'Where the money goes back to'}
              hint="The other side of the entry. Cash on hand unless it was drawn from the bank."
            >
              <Select value={fromAccount} onChange={(e) => setFromAccount(e.target.value)}>
                {accounts
                  .filter((a) => a.type === 'asset' && a.code !== accountFor(openBox))
                  .map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
              </Select>
            </Field>
          )}

          {counting && countPreview && countPreview.toRestore > 0 && (
            <Field label="Bring it back to its level at the same time">
              <Select value={alsoTopUp ? 'yes' : 'no'} onChange={(e) => setAlsoTopUp(e.target.value === 'yes')}>
                <option value="yes">Yes, put {money(countPreview.toRestore)} back in</option>
                <option value="no">No, just record the count</option>
              </Select>
            </Field>
          )}

          <Field
            label={counting && needsExplaining(countPreview?.variance ?? 0) ? 'What happened' : 'Note'}
            hint={
              counting && needsExplaining(countPreview?.variance ?? 0)
                ? 'Worth saying now. By next week nobody remembers, and an unexplained difference reads as something worse than it usually is.'
                : undefined
            }
          >
            <Textarea rows={2} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          </Field>
        </Modal>
      )}

      {/*
        The till's own spend form, opened against this box.

        Which means a market run out of the tin is itemised into ingredients
        and lands on the shelf exactly as one paid from a drawer does — the
        same code, so the two cannot disagree about how a purchase reaches
        stock. The box is fixed by the screen, so the form never asks whose
        money it was.
      */}
      {spending && openBox && (
        <ExpenseModal
          module={(openBox.module || 'kitchen') as Module}
          venueId="main"
          shiftId=""
          settings={settings as Settings}
          userId={userId}
          askPaidFrom={false}
          fromFloatId={openBox.$id}
          onClose={() => setSpending(false)}
          onDone={(m) => {
            setSpending(false);
            toast(m);
            void load();
            void openDetail(openBox);
          }}
        />
      )}

      {/* ------------------------------------------------------- adding a box */}

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.name}` : 'Add a petty cash box'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void saveBox()} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

          <Field label="What it is called" hint="Whose it is, or where it lives. “Kitchen tin”, “Ama's float”.">
            <Input
              value={editing.name ?? ''}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </Field>

          <Field
            label={`What it holds when full (${settings?.currency_symbol ?? ''})`}
            hint="The fixed amount. This is what makes the box checkable — cash in it plus what has been spent since should always come to this."
          >
            <Input
              value={editing.fixed_amount === undefined ? '' : String(editing.fixed_amount)}
              inputMode="decimal"
              onChange={(e) => setEditing({ ...editing, fixed_amount: e.target.value as unknown as number })}
            />
          </Field>

          <Field label="Who holds it" hint="A box with nobody's name on it is a box nobody counts.">
            <Select
              value={editing.custodian_id ?? ''}
              onChange={(e) => setEditing({ ...editing, custodian_id: e.target.value })}
            >
              <option value="">Nobody in particular</option>
              {staff.map((s) => <option key={s.$id} value={s.$id}>{s.display_name}</option>)}
            </Select>
          </Field>

          <Field
            label="Which side of the business"
            hint="Leave it on all three for a single office tin. Set it and only that side sees the box when recording a spend."
          >
            <Select
              value={editing.module ?? ''}
              onChange={(e) => setEditing({ ...editing, module: e.target.value })}
            >
              <option value="">All of them</option>
              <option value="kitchen">Bistro</option>
              <option value="bar">Bar</option>
              <option value="craft">Craft shop</option>
            </Select>
          </Field>

          <Field
            label="Where it sits in the accounts"
            hint="Its own asset account, separate from the till's cash, so a shortage in the tin and a shortage in the drawer are never the same number."
          >
            <Select
              value={editing.account_code || ACCOUNTS.pettyCash}
              onChange={(e) => setEditing({ ...editing, account_code: e.target.value })}
            >
              {accounts.filter((a) => a.type === 'asset').map((a) => (
                <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
              ))}
            </Select>
          </Field>

          {editing.$id && (
            <Field label="In use" hint="Retiring a box keeps its history and stops it being offered for new spending.">
              <Select
                value={editing.active === false ? 'no' : 'yes'}
                onChange={(e) => setEditing({ ...editing, active: e.target.value === 'yes' })}
              >
                <option value="yes">Yes</option>
                <option value="no">Retired</option>
              </Select>
            </Field>
          )}
        </Modal>
      )}
    </>
  );
}
