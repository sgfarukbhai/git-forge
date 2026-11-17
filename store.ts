// store.ts — the forge's in-memory state and the git object primitives.
//
// Everything lives in memory: one Store holds every repository, and each repository
// holds its refs and its git objects (commits, trees, blobs, tags) in Maps keyed by
// SHA-1. There is no disk, no clock and no randomness in state: every timestamp and
// identity the server writes is fixed, so two runs on the same requests leave the
// same state.
//
// The git primitives here (pkt-line codec, packfile read/write, delta resolution,
// tree/commit builders) implement the wire formats the git client in the kit speaks.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: an unborn ref, a delete, a create. */
export const ZERO_OID = '0'.repeat(40);

/** The fixed commit timestamp (seconds) and zone every server-made commit carries. */
export const FIXED_COMMIT_TS = 1_700_000_000;
export const FIXED_COMMIT_TZ = '+0000';
/** The fixed author/committer identity every server-made commit carries. */
export const COMMIT_IDENTITY = 'Conformance <conformance@make.fun>';
/** The ISO form of FIXED_COMMIT_TS, for REST commit objects. */
export const FIXED_COMMIT_ISO = '2023-11-14T22:13:20Z';
/** The fixed created/updated stamp every REST/GraphQL resource carries. */
export const FIXED_STAMP = '2026-11-14T06:30:00Z';

/** The token owner's identity: the one viewer the suite's scenario names. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** SHA-1 of `bytes`, hex. */
export function sha1Hex(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** The git object id of a typed object: sha1("<type> <size>\0" + data). */
export function gitOid(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

/** One pkt-line framing `payload` (a string is UTF-8). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet (0000). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet (0001). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a sequence of lines / control packets. */
export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode pkt-lines from the front of `buf`. Returns the packets decoded and the
 * bytes left over (an incomplete packet, or — for receive-pack — the pack bytes
 * that follow the command list's flush).
 */
export function decodePktLines(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------------------
// packfile read / write
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read one git varint (the pack entry size encoding) starting at `off`. */
function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off]! & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[i - 1]! & 0x80) {
    value |= (buf[i]! & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}

/** The smallest `end` in (off, limit] whose slice inflates, or -1. Binary search. */
function inflateEnd(buf: Buffer, off: number, limit: number): number {
  let lo = off + 1;
  let hi = limit;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(off, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  return found;
}

/** Inflate the zlib stream at `off`; returns the object bytes and the next offset. */
function inflateOne(buf: Buffer, off: number): { data: Buffer; next: number } {
  const end = inflateEnd(buf, off, buf.length);
  if (end < 0) throw new Error('pack entry has no complete zlib stream');
  return { data: inflateSync(buf.subarray(off, end)), next: end };
}

/** Apply a git delta to `base`, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const srcSize = readVarint(delta, off);
  off = srcSize.next;
  if (srcSize.value !== base.length) throw new Error('delta source size mismatch');
  const dstSize = readVarint(delta, off);
  off = dstSize.next;
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off]!;
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          cpOff |= delta[off]! << (bit * 8);
          off += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          cpSize |= delta[off]! << (bit * 8);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta op 0 is invalid');
    }
  }
  if (total !== dstSize.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out, total);
}

/**
 * Read a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` supplies objects the pack's deltas may point at outside the pack
 * (the receiver's own store, for thin packs); entries already in the pack resolve
 * against each other. Returns every object by oid.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const pending: Array<{ off: number; baseOff: number; delta: Buffer; typeId: number }> = [];
  const pendingRef: Array<{ off: number; baseOid: string; delta: Buffer; typeId: number }> = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    const first = pack[off]!;
    const typeId = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    while (pack[off - 1]! & 0x80) {
      size |= (pack[off]! & 0x7f) << shift;
      shift += 7;
      off += 1;
    }
    if (typeId === 6) {
      // OFS_DELTA: the git offset encoding.
      let byte = pack[off]!;
      off += 1;
      let baseOff = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off]!;
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (byte & 0x7f);
      }
      const basePos = entryStart - baseOff;
      const inflated = inflateOne(pack, off);
      off = inflated.next;
      pending.push({ off: entryStart, baseOff: basePos, delta: inflated.data, typeId });
    } else if (typeId === 7) {
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const inflated = inflateOne(pack, off);
      off = inflated.next;
      pendingRef.push({ off: entryStart, baseOid, delta: inflated.data, typeId });
    } else {
      const type = PACK_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const inflated = inflateOne(pack, off);
      off = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const oid = gitOid(type, inflated.data);
      const obj: GitObject = { type, data: inflated.data };
      objects.set(oid, obj);
      byOffset.set(entryStart, obj);
    }
  }
  // Resolve deltas. OFS deltas point at earlier entries, so one pass in file order
  // resolves them; REF deltas may point anywhere, so retry until nothing changes.
  for (const item of pending) {
    const base = byOffset.get(item.baseOff);
    if (base === undefined) throw new Error('OFS delta base not in pack');
    const data = applyDelta(base.data, item.delta);
    const obj: GitObject = { type: base.type, data };
    objects.set(gitOid(base.type, data), obj);
    byOffset.set(item.off, obj);
  }
  let remaining = pendingRef;
  while (remaining.length > 0) {
    const next: typeof remaining = [];
    let progressed = false;
    for (const item of remaining) {
      const base = objects.get(item.baseOid) ?? resolveBase?.(item.baseOid);
      if (base === undefined) {
        next.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      objects.set(gitOid(base.type, data), { type: base.type, data });
      progressed = true;
    }
    if (!progressed) throw new Error('REF delta base not found');
    remaining = next;
  }
  return objects;
}

/** Build a packfile v2 from plain objects (no deltas), in the given order. */
export function writePack(objects: ReadonlyArray<GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    headerBytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// trees and commits
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit object's raw bytes. Tolerant of extra header lines. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2).replace(/\n$/, '') : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** Parse a tag object's raw bytes (object/type/tag/tagger + message). */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

/** Build a commit object (fixed identity, fixed timestamp). */
export function buildCommit(tree: string, parents: string[], message: string): GitObject {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${COMMIT_IDENTITY} ${FIXED_COMMIT_TS} ${FIXED_COMMIT_TZ}`);
  lines.push(`committer ${COMMIT_IDENTITY} ${FIXED_COMMIT_TS} ${FIXED_COMMIT_TZ}`);
  lines.push('');
  lines.push(message);
  return { type: 'commit', data: Buffer.from(lines.join('\n'), 'utf8') };
}

/** Build a tag object (fixed identity, fixed timestamp). */
export function buildTag(object: string, type: string, tag: string, message: string): GitObject {
  const lines = [
    `object ${object}`,
    `type ${type}`,
    `tag ${tag}`,
    `tagger ${COMMIT_IDENTITY} ${FIXED_COMMIT_TS} ${FIXED_COMMIT_TZ}`,
    '',
    message,
  ];
  return { type: 'tag', data: Buffer.from(lines.join('\n'), 'utf8') };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Encode tree entries into a tree object. */
export function encodeTree(entries: TreeEntry[]): GitObject {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return { type: 'tree', data: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  /** Cached REST JSON string (response varies only in X-GitHub-Request-Id). */
  jsonCache?: string;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The base tip at PR creation, for the three-way conflict check. */
  baseShaAtCreate: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  user: string;
  createdAt: string;
}

export interface Repo {
  dbId: number;
  id: string;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
}

/** The whole forge: every repository, keyed by "owner/name". */
export class Store {
  repos = new Map<string, Repo>();
  nextDbId = 1;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo {
    const dbId = this.nextDbId;
    this.nextDbId += 1;
    const repo: Repo = {
      dbId,
      id: Buffer.from(`Repository:${dbId}`, 'utf8').toString('base64'),
      name,
      owner,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: 'main',
      createdAt: FIXED_STAMP,
      updatedAt: FIXED_STAMP,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    // The six labels the suite's scenario seeds with (harmless to pre-seed: the
    // label checks create their own, and a label must exist before an issue may
    // carry it).
    for (const label of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      repo.labels.set(label, { name: label, color: 'd73a4a', description: '' });
    }
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  /** Every repository owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.dbId - b.dbId);
    return out;
  }
}

/** The object id a commit's tree points at, or '' when the object is missing. */
export function commitTree(repo: Repo, commitOid: string): string {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

/** Walk a commit's ancestry (newest first by traversal), following all parents. */
export function walkCommits(repo: Repo, tip: string, limit = 100_000): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const parsed = parseCommit(obj.data);
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i]!);
  }
  return out;
}

/** Whether `ancestor` is reachable from `tip` (an ancestor of, or equal to, tip). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** Flatten a tree into path -> {oid, mode}, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = pre === '' ? entry.name : `${pre}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/**
 * Build (and store) the tree for a flat path map. Returns the root tree oid.
 * Entries sort by name bytes, directories compared as name + '/'.
 */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  return recurseFromFlat(repo, flat);
}

/** Recursive helper: build a tree from a flat map whose keys are relative paths. */
function recurseFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  const groups = new Map<string, { file?: { oid: string; mode: string }; sub: string[] }>();
  for (const path of flat.keys()) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      groups.set(path, { file: flat.get(path)!, sub: [] });
    } else {
      const head = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let group = groups.get(head);
      if (group === undefined) {
        group = { sub: [] };
        groups.set(head, group);
      }
      group.sub.push(rest);
    }
  }
  const sorted = [...groups.entries()].sort((a, b) => {
    const ka = a[1].file !== undefined ? a[0] : `${a[0]}/`;
    const kb = b[1].file !== undefined ? b[0] : `${b[0]}/`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const entries: TreeEntry[] = [];
  for (const [name, group] of sorted) {
    if (group.file !== undefined) {
      entries.push({ mode: group.file.mode, name, oid: group.file.oid });
    } else {
      const relFlat = new Map<string, { oid: string; mode: string }>();
      for (const [full, value] of flat) {
        if (full.startsWith(`${name}/`)) relFlat.set(full.slice(name.length + 1), value);
      }
      entries.push({ mode: '40000', name, oid: recurseFromFlat(repo, relFlat) });
    }
  }
  const tree = encodeTree(entries);
  const oid = gitOid('tree', tree.data);
  repo.objects.set(oid, tree);
  return oid;
}
