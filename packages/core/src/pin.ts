/**
 * Staff PINs.
 *
 * Kitchen and floor staff sign in on a shared device with a PIN, not an email
 * and password. Typing a password on a greasy tablet between orders does not
 * happen; what happens instead is one account left permanently signed in and
 * every action attributed to whoever set it up.
 *
 * A four-digit PIN is not a password and is not treated as one. It identifies
 * a person on a device that is ALREADY authenticated — the device holds the
 * real session. The PIN answers "which of you is this?", not "should you be
 * here at all".
 */

/** SHA-256 of the PIN with a per-person salt, so identical PINs differ. */
export async function hashPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const newSalt = (): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Stored as `salt$hash` so one field carries both. */
export const encodePin = async (pin: string): Promise<string> => {
  const salt = newSalt();
  return `${salt}$${await hashPin(pin, salt)}`;
};

export async function verifyPin(pin: string, stored?: string): Promise<boolean> {
  if (!stored || !stored.includes('$')) return false;
  const [salt, hash] = stored.split('$');
  return (await hashPin(pin, salt)) === hash;
}

/** Reject the PINs everyone picks first. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'A PIN is 4 to 6 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'Not all the same digit.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Not a run of consecutive digits.';
  if (['1234', '0000', '1111', '1212', '2580'].includes(pin)) return 'That PIN is too common — pick another.';
  return null;
}
