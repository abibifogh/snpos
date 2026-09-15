/**
 * A card payment has to carry the machine's number.
 *
 * The STAN — the trace number the terminal prints on its roll — is the only
 * thing a card payment in this system and a line on the bank's settlement
 * report have in common. Without it, "the card takings are GH₵40 short" is a
 * sentence with no next step: nobody can say which sale, which terminal or
 * which night, and the difference goes in the drawer-count column as an
 * unexplained number that stays unexplained.
 *
 * It was asked for, and not insisted on. The method carries a
 * `requires_reference` flag, the till honoured it, and two other screens did
 * not: the kitchen screen showed the box and accepted it empty, and the tab
 * settler labelled it "if there is one". So whether a card payment could be
 * reconciled depended on which screen the person happened to be standing at.
 *
 * Two rules, and the first one is the point:
 *
 *   - A CARD payment always needs it, whatever the method's flag says. The
 *     flag is a setting somebody can forget to tick, and a card sale without
 *     its trace number is unreconcilable however the method was configured.
 *   - Anything else needs it when the method says so — mobile money usually
 *     does, cash never does — which is the behaviour that already existed and
 *     is left alone.
 *
 * Pure. Imports nothing at runtime.
 */

export interface TenderMethod {
  /** 'card', 'mobile_money', 'cash', … See the payment_methods schema. */
  kind?: string;
  /** What the till calls it: "Visa machine", "Momo". Used in the message. */
  name?: string;
  /** The per-method setting. Honoured for everything except a card. */
  requires_reference?: boolean;
}

/** Card sales always. Everything else only where the method asks. */
export function referenceRequired(method: TenderMethod | null | undefined): boolean {
  if (!method) return false;
  return method.kind === 'card' || method.requires_reference === true;
}

/**
 * What is missing, in the words of somebody standing at a terminal.
 *
 * Null when nothing is. The message names the machine rather than the field,
 * because the person reading it is looking at a card terminal and a screen,
 * and only one of them has the number on it.
 */
export function referenceProblem(
  method: TenderMethod | null | undefined,
  reference: string | undefined | null,
): string | null {
  if (!referenceRequired(method)) return null;
  if (String(reference ?? '').trim() !== '') return null;

  return method?.kind === 'card'
    ? 'Enter the number from the card machine — the STAN on its printout. A card payment without it '
      + 'cannot be matched to the bank, so a shortfall at the end of the night has nothing to check against.'
    : `Enter the reference for the ${method?.name?.trim() || 'payment'}.`;
}

/** The label and hint for the box, so every screen asks for it the same way. */
export function referenceWords(method: TenderMethod | null | undefined): { label: string; hint: string } {
  if (method?.kind === 'card') {
    return {
      label: 'Card machine number (STAN)',
      hint: 'On the terminal’s printout. It is what matches this sale to the bank.',
    };
  }
  if (method?.kind === 'mobile_money') {
    return { label: 'Transaction ID', hint: 'From the mobile money message.' };
  }
  return {
    label: `${method?.name?.trim() || 'Payment'} reference`,
    hint: 'From the machine or the message.',
  };
}
