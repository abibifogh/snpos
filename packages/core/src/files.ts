import { storage, teams, account, ID, Permission, Role } from './client';
import type { Settings } from './types';

/**
 * Uploading, aware of which storage layout provisioning ended up with.
 *
 * With separate buckets, the bucket itself decides who can read a file. With
 * one shared bucket — which a capped plan forces — the bucket cannot, so every
 * upload must carry its own permissions. Getting this wrong would publish
 * expense receipts, so the choice is made here rather than at each call site.
 */
export type FilePurpose = 'menu' | 'branding' | 'receipt';

const BUCKET_BY_PURPOSE: Record<FilePurpose, string> = {
  menu: 'menu-images',
  branding: 'branding',
  receipt: 'receipts',
};

export const bucketFor = (purpose: FilePurpose, settings?: Pick<Settings, 'storage_mode' | 'shared_bucket_id'> | null): string =>
  settings?.storage_mode === 'single' && settings.shared_bucket_id
    ? settings.shared_bucket_id
    : BUCKET_BY_PURPOSE[purpose];

/**
 * Roles the signed-in user actually holds.
 *
 * Appwrite refuses to let anyone grant a permission they do not have
 * themselves — an admin who is not also in `managers` cannot hand a file to
 * `team:managers`. So ask, rather than assume, and grant only what is really
 * available.
 */
let cachedTeams: string[] | null = null;

async function myTeams(): Promise<string[]> {
  if (cachedTeams) return cachedTeams;
  try {
    const res = await teams.list();
    cachedTeams = res.teams.map((t) => t.$id);
  } catch {
    cachedTeams = [];
  }
  return cachedTeams;
}

/**
 * Who may read a file of this purpose once uploaded.
 *
 * Menu photos and branding are shown to anyone holding a QR code, so they are
 * public by necessity. Receipts are money records and never are.
 *
 * Write permissions are deliberately NOT set per file: the bucket already
 * decides who may upload and delete, and repeating it here only creates a way
 * for the two to disagree.
 */
async function permissionsFor(purpose: FilePurpose): Promise<string[]> {
  if (purpose !== 'receipt') return [Permission.read(Role.any())];

  const mine = await myTeams();
  const perms = ['managers', 'admins']
    .filter((t) => mine.includes(t))
    .map((t) => Permission.read(Role.team(t)));

  // Always include the uploader. Without at least one reader a restricted file
  // becomes unreadable by everyone, including the person who just attached it.
  const me = await account.get().catch(() => null);
  if (me) perms.push(Permission.read(Role.user(me.$id)));

  return perms;
}

export interface UploadResult {
  fileId: string;
  bucketId: string;
}

export async function uploadFile(
  file: File,
  purpose: FilePurpose,
  settings?: Pick<Settings, 'storage_mode' | 'shared_bucket_id'> | null,
): Promise<UploadResult> {
  const bucketId = bucketFor(purpose, settings);
  const created = await storage.createFile(bucketId, ID.unique(), file, await permissionsFor(purpose));
  return { fileId: created.$id, bucketId };
}

export async function deleteFile(
  fileId: string,
  purpose: FilePurpose,
  settings?: Pick<Settings, 'storage_mode' | 'shared_bucket_id'> | null,
): Promise<void> {
  await storage.deleteFile(bucketFor(purpose, settings), fileId);
}

/** A resized preview URL. Full-size originals are wasteful in a list. */
export function previewUrl(
  fileId: string | undefined,
  purpose: FilePurpose,
  settings?: Pick<Settings, 'storage_mode' | 'shared_bucket_id'> | null,
  width = 320,
  height = 320,
): string | null {
  if (!fileId) return null;
  return storage.getFilePreview(bucketFor(purpose, settings), fileId, width, height).toString();
}

export function downloadUrl(
  fileId: string,
  purpose: FilePurpose,
  settings?: Pick<Settings, 'storage_mode' | 'shared_bucket_id'> | null,
): string {
  return storage.getFileView(bucketFor(purpose, settings), fileId).toString();
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

/** Reject bad uploads before they cost a round trip. Returns null when fine. */
export function validateImage(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'Use a JPG, PNG or WebP image.';
  if (file.size > MAX_IMAGE_BYTES) return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`;
  return null;
}
