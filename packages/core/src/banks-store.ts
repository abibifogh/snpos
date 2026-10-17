import { saveDropping } from './client';
import { postEntry } from './ledger';
import { nextMoneyCode, newMoneyAccountProblem, moneyTransferProblem, transferLines } from './banks';
import type { MoneyAccountKind } from './banks';
import type { AccountRow } from './ledger-math';

/** Add a bank account, a MoMo wallet or a cash float as an account of its own. */
export async function addMoneyAccount(input: { name: string; kind: MoneyAccountKind; accounts: AccountRow[] }): Promise<string> {
  const why = newMoneyAccountProblem(input.name, input.accounts);
  if (why) throw new Error(why);
  const code = nextMoneyCode(input.accounts) as string;
  const { dropped } = await saveDropping('accounts', null, {
    code,
    name: input.name.trim().slice(0, 120),
    type: 'asset',
    system: false,
    cash_kind: input.kind,
  });
  if (dropped.includes('cash_kind')) {
    throw new Error(`Added as ${code}, but this database cannot mark it as money yet. Run Provision in GitHub Actions; until then it is an ordinary asset account.`);
  }
  return code;
}

/** Money moved from one account to another: banking cash, topping up a wallet, between banks. */
export async function postTransfer(venueId: string, input: {
  from: string; to: string; amount: number; date: Date; note?: string; userId: string;
}) {
  const why = moneyTransferProblem(input.from, input.to, input.amount);
  if (why) throw new Error(why);
  return postEntry(venueId, {
    date: input.date,
    source: 'adjustment',
    sourceId: `transfer:${input.from}:${input.to}:${input.date.toISOString().slice(0, 10)}:${Math.round(input.amount)}`,
    memo: input.note?.trim() ? `Transfer · ${input.note.trim()}` : 'Transfer between accounts',
    postedBy: input.userId,
  }, transferLines(input.from, input.to, Math.round(input.amount), input.note));
}
