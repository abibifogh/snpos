import { inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP reader, because .docx and .xlsx are ZIP archives of XML.
 *
 * Written by hand rather than pulled from npm on purpose: this tool reads
 * student coursework, sometimes on a machine with no network and always with
 * files from people who are being assessed. A dependency tree is a supply
 * chain, and a marking tool that phones home or executes an install script is
 * a worse problem than the one it solves. Node's zlib is all a ZIP needs.
 *
 * Only the two compression methods that Office actually emits are supported,
 * stored (0) and deflate (8). Anything else is reported rather than guessed at.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

/** Find the End Of Central Directory record, scanning back from the tail. */
function findEocd(buf) {
  // The EOCD is last, but a trailing comment of up to 64KB may follow it, so
  // the signature has to be hunted rather than read from a fixed offset.
  const start = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Read every entry's name and bytes. Returns a Map of path -> Buffer.
 *
 * Entries are read lazily-ish: names come from the central directory (which is
 * authoritative) but bytes are sliced from the local header, since that is
 * where the actual data lives.
 */
export function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

  let entryCount = buf.readUInt16LE(eocd + 10);
  let centralOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate
  // record. Rare for coursework, but a 70MB thesis with images can reach it.
  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === ZIP64_LOCATOR_SIG) {
        const z64 = Number(buf.readBigUInt64LE(i + 8));
        if (buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
          entryCount = Number(buf.readBigUInt64LE(z64 + 32));
          centralOffset = Number(buf.readBigUInt64LE(z64 + 48));
        }
        break;
      }
    }
  }

  const files = new Map();
  let p = centralOffset;

  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) break;

    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry, no payload

    try {
      files.set(name, readLocalEntry(buf, localOffset, method, compressedSize));
    } catch {
      // One unreadable part should not cost us the rest of the document; the
      // caller will notice the file it wanted is missing from the map.
    }
  }

  return files;
}

function readLocalEntry(buf, offset, method, compressedSize) {
  if (buf.readUInt32LE(offset) !== LOCAL_SIG) throw new Error('bad local header');

  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;

  // The local header's own size fields are zero when a data descriptor is used
  // (bit 3 of the flags), which is why the central directory's copy is the one
  // we trust and pass in.
  const data = buf.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`unsupported compression method ${method}`);
}

/** Convenience: read one entry as UTF-8 text, or '' when it is absent. */
export function zipText(files, name) {
  const b = files.get(name);
  return b ? b.toString('utf8') : '';
}
