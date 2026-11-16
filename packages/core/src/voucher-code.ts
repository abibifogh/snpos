/**
 * A voucher's code, checked before it is saved.
 *
 * The database holds one voucher per code, so a code already on another
 * voucher is refused there with "Document violates a unique attribute
 * constraint", which says nothing about which voucher or what to do. The
 * one it clashes with is usually switched off or ended, so it is no longer
 * on anybody's mind. This finds it first and names it.
 *
 * Pure. Imports nothing at runtime.
 */

export interface CodedVoucher {
  $id: string;
  name?: string | null;
  code?: string | null;
  active?: boolean | null;
  ends_at?: string | null;
}

/** The code as stored: trimmed, upper case, or null when there is none. */
export function storedCode(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase();
  return c === '' ? null : c;
}

/** Why this code cannot be used, naming the voucher that already has it, or null. */
export function voucherCodeProblem(
  code: string | null | undefined,
  others: CodedVoucher[],
  selfId?: string | null,
  now: Date = new Date(),
): string | null {
  const c = storedCode(code);
  if (!c) return null;
  const clash = others.find((v) => v.$id !== selfId && storedCode(v.code) === c);
  if (!clash) return null;
  const state = clash.active === false
    ? ', which is switched off'
    : clash.ends_at && new Date(clash.ends_at).getTime() < now.getTime()
      ? ', which has ended'
      : '';
  return `${c} is already the code of "${clash.name || 'another voucher'}"${state}. Choose a different code, or open that voucher and use it again.`;
}
