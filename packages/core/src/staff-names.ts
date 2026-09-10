import { listAll } from './client';
import { nameBook } from './staff-words';
import type { StaffProfile } from './types';

/** Every staff member's name, by id. Fails soft to an empty book. */
export const loadStaffNames = async (): Promise<Map<string, string>> =>
  nameBook(await listAll<StaffProfile>('staff_profiles').catch(() => [] as StaffProfile[]));
