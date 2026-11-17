// git-http.ts — git smart HTTP: info/refs, upload-pack (v2 and v0), receive-pack.
//
// The wire contract is the one the kit's git-client.ts speaks: pkt-line framing,
// v2 capability advertisement and the ls-refs/fetch command protocol, v0
// advertisements with the "# service=" preamble and NUL-separated capabilities,
// and the receive-pack report-status stream inside sideband band 1. No git binary
// is involved anywhere: packs are read and written by store.ts.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  gitOid,
  isAncestor,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';
import { listRefs, peelToCommit } from './domain.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const AGENT = 'forge/1.0.0';
const V2_CAPS = ['ls-refs=unborn', 'fetch=shallow thin-pack ofs-delta', `agent=${AGENT}`, 'object-format=sha1'];
const V0_UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/main`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** Send raw bytes with a content type. */
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Send a JSON error body (used for the git routes' 404s). */
function sendGitJson(res: ServerResponse, status: number, message: string): void {
  const text = `${JSON.stringify({ message })}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Read a whole request body. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The commit timestamp (seconds) out of a commit object, or 0. */
function commitTimestamp(repo: Repo, oid: string): number {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return 0;
  const text = obj.data.toString('utf8');
  const match = /author [^\n]* (\d+) [+-]\d{4}\n/.exec(text);
  return match === null ? 0 : Number(match[1]);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  service: string,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendGitJson(res, 404, 'Not Found');
    return;
  }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const contentType = `application/x-${service}-advertisement`;
  if (isV2) {
    const lines = ['version 2\n', ...V2_CAPS.map((cap) => `${cap}\n`)];
    sendRaw(res, 200, contentType, encodePktLines([...lines, 'flush']));
    return;
  }
  const caps = service === 'git-receive-pack' ? V0_RECEIVE_CAPS : V0_UPLOAD_CAPS;
  const refs = listRefs(repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      if (ref.unborn === true) {
        // An unborn repo advertises only the pseudo-ref; listRefs returns HEAD +
        // the default branch as unborn, so emit the pseudo-ref once instead.
        if (index === 0) lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
        return;
      }
      const suffix = index === 0 ? `\0${caps}` : '';
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  sendRaw(res, 200, contentType, encodePktLines(lines));
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/** Work out which objects a fetch sends, and the shallow/unshallow boundaries. */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const oldBoundaries = new Set(request.shallow);

  // Walk one tree, calling `fn` for the tree itself and every entry beneath it.
  const walkTree = (treeOid: string, fn: (oid: string, mode: string) => void): void => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    fn(treeOid, '40000');
    let off = 0;
    const data = obj.data;
    while (off < data.length) {
      const space = data.indexOf(0x20, off);
      const nul = data.indexOf(0x00, space);
      if (space < 0 || nul < 0) break;
      const mode = data.subarray(off, space).toString('ascii');
      const child = data.subarray(nul + 1, nul + 21).toString('hex');
      if (mode === '40000') walkTree(child, fn);
      else fn(child, mode);
      off = nul + 21;
    }
  };

  // Everything the client already holds: the closure of its haves, stopping at
  // its shallow boundaries (their parents are not held). Deepen-not tips count
  // as held too: their ancestors must not be sent.
  const held = new Set<string>();
  const collectHeld = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    held.add(oid);
    if (obj.type === 'tag') {
      collectHeld(parseTag(obj.data).object);
      return;
    }
    if (obj.type === 'tree') {
      walkTree(oid, (child) => held.add(child));
      return;
    }
    if (obj.type !== 'commit') return;
    walkTree(parseCommit(obj.data).tree, (child) => held.add(child));
    if (oldBoundaries.has(oid)) return;
    for (const parent of parseCommit(obj.data).parents) collectHeld(parent);
  };
  for (const have of request.haves) collectHeld(have);
  for (const not of request.deepenNot) {
    const tip = repo.refs.get(not) ?? repo.refs.get(`refs/heads/${not}`) ?? '';
    if (tip !== '') collectHeld(tip);
  }

  const included = new Map<string, GitObject>();
  const boundary = new Set<string>();
  const unshallow = new Set<string>();
  const seen = new Set<string>();

  const include = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) included.set(oid, obj);
  };

  // Walk from the wants. A want that is also a have is not re-sent, but the
  // walk still goes through it: a deepen fetch's parent lives past the tip the
  // client already holds.
  const visit = (oid: string, dist: number): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    if (obj.type === 'tag') {
      include(oid);
      visit(parseTag(obj.data).object, dist);
      return;
    }
    if (obj.type === 'tree' || obj.type === 'blob') {
      include(oid);
      return;
    }
    // Commit.
    const isHeld = held.has(oid);
    if (!isHeld) include(oid);
    const oldBoundary = oldBoundaries.has(oid);
    const depthLimited = request.depth !== null && dist >= request.depth - 1;
    const timeLimited = request.deepenSince !== null && commitTimestamp(repo, oid) <= request.deepenSince;
    const canTraverse = !(depthLimited || timeLimited) && !(oldBoundary && request.depth === null && request.deepenSince === null);
    if (oldBoundary && canTraverse) unshallow.add(oid);
    if (!canTraverse) {
      // A boundary of the result: sent commits cut off here, and old boundaries
      // that stay shallow. A merely-held commit is not a boundary.
      if (!isHeld || oldBoundary) boundary.add(oid);
      return;
    }
    for (const parent of parseCommit(obj.data).parents) visit(parent, dist + 1);
  };

  for (const want of request.wants) visit(want, 0);

  // The trees and blobs of every included commit, minus what the client holds.
  for (const obj of [...included.values()]) {
    if (obj.type === 'commit') {
      walkTree(parseCommit(obj.data).tree, (child) => include(child));
    }
  }

  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const want of request.wants) {
    for (const ref of listRefs(repo)) {
      if (ref.oid === want && ref.name !== 'HEAD') wantedRefs.push({ oid: want, ref: ref.name });
    }
  }
  return {
    objects: [...included.values()],
    shallow: [...boundary].sort(),
    unshallow: [...unshallow].sort(),
    wantedRefs,
  };
}

/** Chunk pack bytes into sideband band-1 pkt-lines (payload <= 65515 bytes). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendGitJson(res, 404, 'Not Found');
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  const contentType = 'application/x-git-upload-pack-result';
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (isV2) {
    const command = lines[0]?.replace(/\n$/, '') ?? '';
    if (command === 'command=ls-refs') {
      handleLsRefs(res, repo, lines.slice(1), contentType);
      return;
    }
    if (command === 'command=fetch') {
      handleFetchV2(res, repo, lines.slice(1), contentType);
      return;
    }
    sendGitJson(res, 400, `Unknown v2 command ${JSON.stringify(command)}`);
    return;
  }
  handleFetchV0(res, repo, packets, contentType);
}

/** v2 ls-refs: peel / symrefs / unborn / ref-prefix, server-side filtered. */
function handleLsRefs(res: ServerResponse, repo: Repo, lines: string[], contentType: string): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (!pastDelim) {
      // Header lines (agent=, object-format=) come before the delimiter; the
      // decoder drops delim packets, so arguments start after the first line
      // that is not a known header.
      if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
      pastDelim = true;
    }
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const out: string[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // HEAD is listed only when no prefix filters it out: a ref-prefix check
  // requires every returned ref to start with the prefix, and "HEAD" does not
  // start with "refs/heads/".
  const headKept = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  for (const ref of listRefs(repo)) {
    if (ref.name === 'HEAD') {
      if (tip === '') {
        // An unborn repo answers with the unborn HEAD line only: a
        // "refs/heads/main" line here would make an empty clone look non-empty.
        if (unborn && headKept) {
          out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
        }
        continue;
      }
      if (!symrefs) continue;
      if (!headKept) continue;
      out.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
      continue;
    }
    if (ref.unborn === true) continue;
    if (!keep(ref.name)) continue;
    const attrs: string[] = [];
    if (peel && ref.peeled !== undefined) attrs.push(`peeled:${ref.peeled}`);
    out.push(`${ref.oid} ${ref.name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`);
  }
  sendRaw(res, 200, contentType, encodePktLines([...out, 'flush']));
}

/** v2 fetch: acknowledgments / shallow-info / wanted-refs / packfile sections. */
function handleFetchV2(res: ServerResponse, repo: Repo, lines: string[], contentType: string): void {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
  }
  const parts: Buffer[] = [];
  const acks = request.haves.filter((oid) => repo.objects.has(oid));
  parts.push(encodePktLines(['acknowledgments\n', ...(acks.length > 0 ? [...acks.map((oid) => `ACK ${oid}\n`), 'ready\n'] : ['NAK\n']), 'delim']));
  if (request.wants.length === 0) {
    parts.push(encodePktLines(['flush']));
    sendRaw(res, 200, contentType, Buffer.concat(parts));
    return;
  }
  const plan = planFetch(repo, request);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const section: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) section.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) section.push(`unshallow ${oid}\n`);
    section.push('delim');
    parts.push(encodePktLines(section));
  }
  if (plan.wantedRefs.length > 0) {
    const section: string[] = ['wanted-refs\n'];
    for (const ref of plan.wantedRefs) section.push(`${ref.oid} ${ref.ref}\n`);
    section.push('delim');
    parts.push(encodePktLines(section));
  }
  const pack = writePack(plan.objects);
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandPack(pack));
  parts.push(encodePktLines(['flush']));
  sendRaw(res, 200, contentType, Buffer.concat(parts));
}

/** v0 fetch: NAK/ACK + shallow lines, then the sideband pack. */
function handleFetchV0(
  res: ServerResponse,
  repo: Repo,
  packets: Array<{ kind: string; payload: Buffer }>,
  contentType: string,
): void {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  let inHaves = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inHaves = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      request.wants.push(rest.split(' ')[0]!);
    } else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
  }
  void inHaves;
  const parts: Buffer[] = [];
  const acks = request.haves.filter((oid) => repo.objects.has(oid));
  const ackLines: string[] = acks.length > 0 ? acks.map((oid) => `ACK ${oid}\n`) : ['NAK\n'];
  let pack = writePack([]);
  if (request.wants.length > 0) {
    const plan = planFetch(repo, request);
    for (const oid of plan.shallow) ackLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) ackLines.push(`unshallow ${oid}\n`);
    pack = writePack(plan.objects);
  }
  parts.push(encodePktLines(ackLines));
  parts.push(sidebandPack(pack));
  parts.push(encodePktLines(['flush']));
  sendRaw(res, 200, contentType, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendGitJson(res, 404, 'Not Found');
    return;
  }
  const contentType = 'application/x-git-receive-pack-result';
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  // Unpack first (real receive-pack unpacks before it checks refs).
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (error) {
      const report = encodePktLines([`unpack ${error instanceof Error ? error.message : 'unpack failed'}\n`, 'flush']);
      sendRaw(res, 200, contentType, Buffer.concat([sidebandPack(report), encodePktLines(['flush'])]));
      return;
    }
  }
  const reportLines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (repo.objects.get(command.newOid) === undefined) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) reportLines.push(`ng ${command.ref} already exists\n`);
      else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (!isAncestor(repo, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const report = encodePktLines(reportLines);
  sendRaw(res, 200, contentType, Buffer.concat([sidebandPack(report), encodePktLines(['flush'])]));
}
