import { storage, ID, Permission, Role } from './client';
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

/** Who may read a file of this purpose once uploaded. */
function permissionsFor(purpose: FilePurpose): string[] {
  const managers = [Permission.read(Role.team('managers')), Permission.read(Role.team('admins'))];
  const writers = [
    Permission.update(Role.team('managers')),
    Permission.update(Role.team('admins')),
    Permission.delete(Role.team('managers')),
    Permission.delete(Role.team('admins')),
  ];
  // Menu photos and branding are shown to anyone with the QR code, so they are
  // public by necessity. Receipts are money records and never are.
  return purpose === 'receipt' ? [...managers, ...writers] : [Permission.read(Role.any()), ...writers];
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
  const created = await storage.createFile(bucketId, ID.unique(), file, permissionsFor(purpose));
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
