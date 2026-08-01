import { Client, Account, Databases, Storage, Teams, ID, Query, Permission, Role } from 'appwrite';

/**
 * One Appwrite client per app, configured from build-time env vars.
 *
 * These values are public by design — they identify the project, they do not
 * grant access. All real authorisation happens through sessions and the
 * collection permissions set during provisioning.
 */
const endpoint = import.meta.env.VITE_APPWRITE_ENDPOINT;
const project = import.meta.env.VITE_APPWRITE_PROJECT;

if (!endpoint || !project) {
  throw new Error(
    'Missing VITE_APPWRITE_ENDPOINT or VITE_APPWRITE_PROJECT. Copy .env.example to .env at the repo root.',
  );
}

export const DB_ID = import.meta.env.VITE_DB_ID || 'snpos';

export const client = new Client().setEndpoint(endpoint).setProject(project);
export const account = new Account(client);
export const db = new Databases(client);
export const storage = new Storage(client);
export const teams = new Teams(client);

export { ID, Query, Permission, Role };

/**
 * Read every row, not just the first page.
 *
 * Appwrite returns 25 documents by default. Silently truncating a menu at 25
 * items is the kind of bug that only shows up once a real menu is loaded.
 */
export async function listAll<T>(collectionId: string, queries: string[] = []): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.listDocuments(DB_ID, collectionId, [...queries, Query.limit(100), Query.offset(offset)]);
    out.push(...(page.documents as unknown as T[]));
    if (page.documents.length < 100 || out.length >= page.total) return out;
  }
}
