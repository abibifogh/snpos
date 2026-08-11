import { storage, teams, account, ID, Permission, Role } from './client';
import type { Settings } from './types';

/**
 * Uploading, aware of which storage layout provisioning ended up with.
 *
 * With separate buckets, the bucket itself decides who can read a file. With
 * one shared bucket, which a capped plan forces, the bucket cannot, so every
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
 * themselves, an admin who is not also in `managers` cannot hand a file to
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

/**
 * Shrink an image before it is uploaded.
 *
 * A photo straight off a phone is commonly 4000px and several megabytes. On a
 * menu it will be shown at a few hundred pixels, so sending the original wastes
 * the customer's data on a mobile connection and the restaurant's storage
 * allowance, and since we serve stored files unchanged, whatever is uploaded
 * is what every diner downloads.
 *
 * Falls back to the original file if anything goes wrong: a slightly large
 * photo is far better than no photo.
 */
export async function downscale(file: File, maxEdge = 1400, quality = 0.85): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 600_000) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export async function uploadFile(
  file: File,
  purpose: FilePurpose,
  settings?: Pick<Settings, 'storage_mode' | 'shared_bucket_id'> | null,
): Promise<UploadResult> {
  const bucketId = bucketFor(purpose, settings);
  // Receipts are evidence and are kept as sent; menu photos are decoration and
  // are shrunk to something a phone on mobile data can actually load.
  const payload = purpose === 'receipt' ? file : await downscale(file);
  const created = await storage.createFile(bucketId, ID.unique(), payload, await permissionsFor(purpose));
  return { fileId: created.$id, bucketId };
}

export async function deleteFile(
  fileId: string,
  purpose: FilePurpose,
  settings?: Pick<Settings, 'storage_mode' | 'shared_bucket_id'> | null,
): Promise<void> {
  await storage.deleteFile(bucketFor(purpose, settings), fileId);
}

/**
 * URL for showing an image.
 *
 * Deliberately NOT getFilePreview. Appwrite's preview endpoint resizes and
 * crops on the fly, which is exactly what a menu wants, but image
 * transformation is a paid feature on Appwrite Cloud, and on the free plan it
 * returns an error that the browser renders as a broken image.
 *
 * getFileView serves the stored file unchanged and works on every plan. The
 * cost is bandwidth, which is why uploads are downscaled before they are sent
 * (see downscale below) rather than served full-size from a phone camera.
 *
 * The width and height arguments are kept so callers read naturally and so
 * switching back to real previews on a paid plan is a one-line change.
 */
export function previewUrl(
  fileId: string | undefined,
  purpose: FilePurpose,
  settings?: Pick<Settings, 'storage_mode' | 'shared_bucket_id'> | null,
  _width = 320,
  _height = 320,
): string | null {
  if (!fileId) return null;
  return storage.getFileView(bucketFor(purpose, settings), fileId).toString();
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
