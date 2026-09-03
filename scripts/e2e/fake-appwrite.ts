/* An in-memory stand-in for Appwrite, for running the real code end to end. */

type Doc = Record<string, any>;
const store = new Map<string, Map<string, Doc>>();
let seq = 0;

export const DB_ID = 'snpos';
export const APPWRITE_ENDPOINT = 'http://fake';
export const appwriteHost = () => 'fake';
export const probeAppwrite = async () => true;
export const noteReachable = () => undefined;
export const everReachedAppwrite = () => true;

export const ID = { unique: () => `gen${++seq}` };

type Q =
  | { op: 'equal' | 'notEqual'; f: string; v: any }
  | { op: 'greaterThan' | 'greaterThanEqual' | 'lessThan' | 'lessThanEqual'; f: string; v: any }
  | { op: 'isNull' | 'isNotNull'; f: string }
  | { op: 'limit' | 'offset'; n: number }
  | { op: 'orderAsc' | 'orderDesc'; f: string }
  | { op: 'select' | 'search' | 'or' | 'and' | 'contains' | 'startsWith'; f?: string; v?: any };

export const Query: any = {
  equal: (f: string, v: any) => ({ op: 'equal', f, v }),
  notEqual: (f: string, v: any) => ({ op: 'notEqual', f, v }),
  greaterThan: (f: string, v: any) => ({ op: 'greaterThan', f, v }),
  greaterThanEqual: (f: string, v: any) => ({ op: 'greaterThanEqual', f, v }),
  lessThan: (f: string, v: any) => ({ op: 'lessThan', f, v }),
  lessThanEqual: (f: string, v: any) => ({ op: 'lessThanEqual', f, v }),
  isNull: (f: string) => ({ op: 'isNull', f }),
  isNotNull: (f: string) => ({ op: 'isNotNull', f }),
  limit: (n: number) => ({ op: 'limit', n }),
  offset: (n: number) => ({ op: 'offset', n }),
  orderAsc: (f: string) => ({ op: 'orderAsc', f }),
  orderDesc: (f: string) => ({ op: 'orderDesc', f }),
  select: (v: any) => ({ op: 'select', v }),
  search: (f: string, v: any) => ({ op: 'search', f, v }),
  contains: (f: string, v: any) => ({ op: 'contains', f, v }),
  startsWith: (f: string, v: any) => ({ op: 'startsWith', f, v }),
  or: (v: any) => ({ op: 'or', v }),
  and: (v: any) => ({ op: 'and', v }),
};

const coll = (c: string) => {
  if (!store.has(c)) store.set(c, new Map());
  return store.get(c) as Map<string, Doc>;
};

/*
  Reads and writes cross a wire in the real thing, so nothing here hands back
  the object it is storing. A stand-in that returns live references lets code
  read a field it has just written and see the new value — which hides exactly
  the class of bug where a difference is worked out after the row has moved.
*/
const copy = <T>(doc: T): T => JSON.parse(JSON.stringify(doc)) as T;

const matches = (doc: Doc, q: Q): boolean => {
  const any = q as any;
  const val = doc[any.f];
  switch (q.op) {
    case 'equal':
      return Array.isArray(any.v) ? any.v.some((x: any) => x === val) : val === any.v;
    case 'notEqual':
      return Array.isArray(any.v) ? !any.v.some((x: any) => x === val) : val !== any.v;
    case 'greaterThan': return val > any.v;
    case 'greaterThanEqual': return val >= any.v;
    case 'lessThan': return val < any.v;
    case 'lessThanEqual': return val <= any.v;
    case 'isNull': return val === null || val === undefined;
    case 'isNotNull': return val !== null && val !== undefined;
    case 'startsWith': return String(val ?? '').startsWith(String(any.v));
    default: return true;
  }
};

export const db = {
  listDocuments: async (_d: string, c: string, queries: any[] = []) => {
    let docs = [...coll(c).values()];
    for (const q of queries) {
      if (!q || typeof q !== 'object') continue;
      if (['limit', 'offset', 'orderAsc', 'orderDesc', 'select', 'search', 'or', 'and'].includes(q.op)) continue;
      docs = docs.filter((d) => matches(d, q));
    }
    const total = docs.length;
    const asc = queries.find((q: any) => q?.op === 'orderAsc');
    const desc = queries.find((q: any) => q?.op === 'orderDesc');
    if (asc) docs.sort((a, b) => (a[asc.f] > b[asc.f] ? 1 : -1));
    if (desc) docs.sort((a, b) => (a[desc.f] < b[desc.f] ? 1 : -1));
    const offset = queries.find((q: any) => q?.op === 'offset')?.n ?? 0;
    const limit = queries.find((q: any) => q?.op === 'limit')?.n ?? 25;
    return { total, documents: docs.slice(offset, offset + limit).map(copy) };
  },
  getDocument: async (_d: string, c: string, id: string) => {
    const doc = coll(c).get(id);
    if (!doc) throw new Error(`no ${c}/${id}`);
    return copy(doc);
  },
  createDocument: async (_d: string, c: string, id: string, data: Doc) => {
    /*
      Appwrite refuses a whole document for one attribute it has never heard
      of, and says which. That is the behaviour that took down every line of a
      count of twenty-three bottles, so the fake has to do it too — a stand-in
      that accepts anything cannot test what happens when the real one does
      not.
    */
    for (const field of unknownFields.get(c) ?? []) {
      if (field in data) throw new Error(`Invalid document structure: Unknown attribute: "${field}"`);
    }
    const realId = id === 'unique()' ? `gen${++seq}` : id;
    const doc = { $id: realId, $createdAt: new Date().toISOString(), ...copy(data) };
    coll(c).set(realId, doc);
    return copy(doc);
  },
  updateDocument: async (_d: string, c: string, id: string, data: Doc = {}) => {
    const doc = coll(c).get(id);
    if (!doc) throw new Error(`no ${c}/${id}`);
    Object.assign(doc, copy(data));
    return copy(doc);
  },
  deleteDocument: async (_d: string, c: string, id: string) => {
    coll(c).delete(id);
    return {};
  },
};

export const client: any = {};
export const account: any = {};
export const storage: any = {};
export const teams: any = {};
export const Permission: any = { read: () => '', write: () => '', update: () => '', delete: () => '' };
export const Role: any = { any: () => '', users: () => '', team: () => '' };

export async function listAll<T>(c: string, queries: any[] = []): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.listDocuments(DB_ID, c, [...queries, Query.limit(100), Query.offset(offset)]);
    out.push(...(page.documents as unknown as T[]));
    if (page.documents.length < 100 || out.length >= page.total) return out;
  }
}

export async function anyExists(c: string, queries: any[] = []) {
  const page = await db.listDocuments(DB_ID, c, [...queries, Query.limit(1)]);
  return { any: page.total > 0, total: page.total };
}

export async function listByIds<T>(c: string, field: string, ids: string[], extra: any[] = []): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  return listAll<T>(c, [...extra, Query.equal(field, unique)]);
}

export async function listSince<T>(c: string, sinceIso: string, extra: any[] = []): Promise<T[]> {
  return listAll<T>(c, [...extra, Query.greaterThanEqual('$createdAt', sinceIso)]);
}

/* The real one, copied rather than simplified: a stand-in that never drops
   anything cannot test the code that depends on it dropping something. */
export async function saveDropping(c: string, id: string | null, payload: Doc) {
  const body = { ...payload };
  const dropped: string[] = [];

  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      const doc = id
        ? await db.updateDocument(DB_ID, c, id, body)
        : await db.createDocument(DB_ID, c, ID.unique(), body);
      return { id: (doc as Doc).$id, dropped };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const unknown = /unknown attribute:?\s*"?([A-Za-z0-9_]+)"?/i.exec(raw);
      if (!unknown || !(unknown[1] in body)) throw e;
      dropped.push(unknown[1]);
      delete body[unknown[1]];
    }
  }
  throw new Error(`Could not save to ${c}.`);
}

export async function tryWrite(work: Promise<unknown>): Promise<boolean> {
  try { await work; return true; } catch { return false; }
}

/* Test helpers, not part of the real client. */
/** Columns this database has never been given, by collection. */
const unknownFields = new Map<string, string[]>();
export const __missingColumns = (c: string, fields: string[]) => unknownFields.set(c, fields);

export const __seed = (c: string, docs: Doc[]) => {
  for (const d of docs) coll(c).set(d.$id, { $createdAt: new Date().toISOString(), ...copy(d) });
};
export const __all = (c: string) => [...coll(c).values()].map(copy);
export const __reset = () => { store.clear(); unknownFields.clear(); };
