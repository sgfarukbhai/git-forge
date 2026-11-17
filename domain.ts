// domain.ts — the forge's domain operations, shared by REST, GraphQL and MCP.
//
// Every mutation goes through here so the three surfaces always agree: a repo,
// issue or pull request created over MCP reads back over REST as the same object,
// with the same ids. Errors are plain {status, message} pairs; the callers turn
// them into their own wire shape.

import {
  FIXED_STAMP,
  VIEWER,
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  commitTree,
  flattenTree,
  gitOid,
  isAncestor,
  parseCommit,
  parseTag,
  walkCommits,
  type Comment,
  type GitObject,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface DomainError {
  status: number;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError };

function err(status: number, message: string): DomainError {
  return { status, message };
}

/** The base64 global id for a kind: "Repository:<dbId>", "Issue:<dbId>:<n>", ... */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

/** Decode a global id back into [kind, ...parts], or null when it is not one. */
export function parseGlobalId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return parts;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.dbId,
    node_id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: repo.owner === VIEWER.login ? VIEWER.id : 0,
      type: 'User',
      avatar_url: '',
    },
    private: repo.private,
    description: repo.description,
    fork: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function createRepo(
  store: Store,
  owner: string,
  body: { name?: unknown; private?: unknown; description?: unknown },
): Result<Repo> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, error: err(422, 'Validation Failed: name is required and must be a valid repository name') };
  }
  const existing = store.getRepo(owner, name);
  if (existing !== undefined) {
    return { ok: false, error: err(422, `Repository ${owner}/${name} already exists`) };
  }
  const repo = store.createRepo(owner, name, {
    private: body.private === true,
    description: typeof body.description === 'string' ? body.description : '',
  });
  return { ok: true, value: repo };
}

// ---------------------------------------------------------------------------
// refs and commits
// ---------------------------------------------------------------------------

export function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The tip of the default branch, or '' when the repo is unborn. */
export function defaultTip(repo: Repo): string {
  return repo.refs.get(headRefName(repo)) ?? '';
}

export function branchTip(repo: Repo, branch: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? '';
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  return {
    sha: oid,
    commit: {
      message: parsed.message,
      author: { name: 'Conformance', email: 'conformance@make.fun', date: '2023-11-14T22:13:20Z' },
      committer: { name: 'Conformance', email: 'conformance@make.fun', date: '2023-11-14T22:13:20Z' },
      tree: { sha: parsed.tree },
    },
    parents: parsed.parents.map((p) => ({ sha: p })),
    author: { login: VIEWER.login },
    committer: { login: VIEWER.login },
  };
}

/** List the commits reachable from `ref` (a branch name, ref or oid), newest first. */
export function listCommits(repo: Repo, ref: string): Result<Array<Record<string, unknown>>> {
  let tip = '';
  if (/^[0-9a-f]{40}$/.test(ref)) tip = ref;
  else if (ref.startsWith('refs/')) tip = repo.refs.get(ref) ?? '';
  else tip = branchTip(repo, ref);
  if (tip === '') return { ok: false, error: err(404, `No commit found for ${ref}`) };
  const out: Array<Record<string, unknown>> = [];
  for (const oid of walkCommits(repo, tip)) {
    const entry = commitJson(repo, oid);
    if (entry !== null) out.push(entry);
  }
  return { ok: true, value: out };
}

export function createRef(repo: Repo, ref: string, sha: string): Result<{ ref: string; sha: string }> {
  if (!ref.startsWith('refs/')) return { ok: false, error: err(422, 'Validation Failed: ref must start with refs/') };
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, error: err(422, 'Validation Failed: sha must be a 40-character hex string') };
  if (repo.objects.get(sha) === undefined) return { ok: false, error: err(422, 'Validation Failed: sha does not exist in this repository') };
  if (repo.refs.has(ref)) return { ok: false, error: err(422, `Reference ${ref} already exists`) };
  repo.refs.set(ref, sha);
  return { ok: true, value: { ref, sha } };
}

// ---------------------------------------------------------------------------
// contents (files)
// ---------------------------------------------------------------------------

export interface ContentFile {
  path: string;
  contentB64: string;
  sha: string;
  size: number;
}

/** Read a file or directory listing at `ref` (branch, ref or oid; default branch). */
export function readContent(
  repo: Repo,
  path: string,
  ref?: string,
): Result<{ file: ContentFile } | { dir: Array<{ type: string; name: string; path: string; sha: string }> }> {
  let tip = '';
  if (ref !== undefined && ref !== '') {
    if (/^[0-9a-f]{40}$/.test(ref)) tip = ref;
    else if (ref.startsWith('refs/')) tip = repo.refs.get(ref) ?? '';
    else tip = branchTip(repo, ref);
  } else {
    tip = defaultTip(repo);
  }
  if (tip === '') return { ok: false, error: err(404, 'Not Found') };
  const tree = commitTree(repo, tip);
  if (tree === '') return { ok: false, error: err(404, 'Not Found') };
  const flat = flattenTree(repo, tree);
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === '') {
    const dir: Array<{ type: string; name: string; path: string; sha: string }> = [];
    const seen = new Set<string>();
    for (const [p, entry] of flat) {
      const first = p.split('/')[0]!;
      if (seen.has(first)) continue;
      seen.add(first);
      const isDir = p.includes('/');
      dir.push({ type: isDir ? 'dir' : 'file', name: first, path: first, sha: entry.oid });
    }
    dir.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { ok: true, value: { dir } };
  }
  const entry = flat.get(clean);
  if (entry !== undefined) {
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return { ok: false, error: err(404, 'Not Found') };
    return {
      ok: true,
      value: {
        file: {
          path: clean,
          contentB64: blob.data.toString('base64'),
          sha: entry.oid,
          size: blob.data.length,
        },
      },
    };
  }
  // A directory: every path under `clean/`.
  const prefix = `${clean}/`;
  const dir: Array<{ type: string; name: string; path: string; sha: string }> = [];
  const seen = new Set<string>();
  for (const [p, e] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0]!;
    if (seen.has(first)) continue;
    seen.add(first);
    dir.push({ type: rest.includes('/') ? 'dir' : 'file', name: first, path: `${clean}/${first}`, sha: e.oid });
  }
  if (dir.length === 0) return { ok: false, error: err(404, 'Not Found') };
  dir.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { ok: true, value: { dir } };
}

/**
 * Write a file through the contents API: one commit on `branch` (created from the
 * default tip when it does not exist yet). `sha` must match the current blob when
 * the file already exists, else 409.
 */
export function putContent(
  repo: Repo,
  path: string,
  body: { message?: unknown; content?: unknown; branch?: unknown; sha?: unknown },
): Result<{ content: ContentFile; commitSha: string; created: boolean }> {
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  if (contentB64 === '') return { ok: false, error: err(422, 'Validation Failed: content is required') };
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return { ok: false, error: err(422, 'Validation Failed: content must be base64') };
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let parent = repo.refs.get(refName);
  let baseFlat = new Map<string, { oid: string; mode: string }>();
  if (parent === undefined) {
    // A new branch starts at the default tip (or at nothing when unborn).
    const tip = defaultTip(repo);
    if (tip !== '') {
      parent = tip;
      baseFlat = flattenTree(repo, commitTree(repo, tip));
    } else {
      parent = undefined;
    }
  } else {
    baseFlat = flattenTree(repo, commitTree(repo, parent));
  }
  const clean = path.replace(/^\/+/, '');
  const existing = baseFlat.get(clean);
  const wantSha = typeof body.sha === 'string' ? body.sha : undefined;
  const fileExisted = existing !== undefined;
  if (existing !== undefined) {
    if (wantSha !== undefined && wantSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { ok: false, error: err(409, 'Conflict: sha does not match the current file') };
    }
    if (wantSha === undefined) {
      // GitHub requires the sha for an update; without one it is a create that
      // collides. Treat it as a conflict-free update only when the bytes differ.
      if (existing.oid === gitOid('blob', content)) {
        return { ok: false, error: err(422, 'Validation Failed: file already exists') };
      }
    }
  } else if (wantSha !== undefined) {
    return { ok: false, error: err(422, 'Validation Failed: sha given for a file that does not exist') };
  }
  const blob: GitObject = { type: 'blob', data: content };
  const blobOid = gitOid('blob', content);
  repo.objects.set(blobOid, blob);
  const flat = new Map(baseFlat);
  flat.set(clean, { oid: blobOid, mode: '100644' });
  const treeOid = buildTreeFromFlat(repo, flat);
  const commit = buildCommit(treeOid, parent === undefined ? [] : [parent], message);
  const commitOid = gitOid('commit', commit.data);
  repo.objects.set(commitOid, commit);
  repo.refs.set(refName, commitOid);
  return {
    ok: true,
    value: {
      content: { path: clean, contentB64: content.toString('base64'), sha: blobOid, size: content.length },
      commitSha: commitOid,
      created: !fileExisted,
    },
  };
}

/** Delete a file through the contents API: one commit removing it. */
export function deleteContent(
  repo: Repo,
  path: string,
  body: { message?: unknown; branch?: unknown; sha?: unknown },
): Result<{ commitSha: string }> {
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName);
  if (parent === undefined) return { ok: false, error: err(404, 'Not Found') };
  const flat = flattenTree(repo, commitTree(repo, parent));
  const clean = path.replace(/^\/+/, '');
  const existing = flat.get(clean);
  if (existing === undefined) return { ok: false, error: err(404, 'Not Found') };
  const wantSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (wantSha !== undefined && wantSha.toLowerCase() !== existing.oid.toLowerCase()) {
    return { ok: false, error: err(409, 'Conflict: sha does not match the current file') };
  }
  flat.delete(clean);
  const treeOid = buildTreeFromFlat(repo, flat);
  const commit = buildCommit(treeOid, [parent], message);
  const commitOid = gitOid('commit', commit.data);
  repo.objects.set(commitOid, commit);
  repo.refs.set(refName, commitOid);
  return { ok: true, value: { commitSha: commitOid } };
}

// ---------------------------------------------------------------------------
// issues, labels, comments
// ---------------------------------------------------------------------------

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    user: { login: issue.user, id: issue.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function createIssue(
  repo: Repo,
  body: { title?: unknown; body?: unknown; labels?: unknown },
): Result<Issue> {
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return { ok: false, error: err(422, 'Validation Failed: title is required') };
  const labels: Label[] = [];
  if (Array.isArray(body.labels)) {
    for (const raw of body.labels) {
      const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null && 'name' in raw ? String((raw as { name: unknown }).name) : '';
      const found = repo.labels.get(name);
      if (found === undefined) return { ok: false, error: err(422, `Validation Failed: label "${name}" does not exist`) };
      labels.push(found);
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: globalId('Issue', repo.dbId, number),
    number,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    user: VIEWER.login,
    createdAt: FIXED_STAMP,
    updatedAt: FIXED_STAMP,
  };
  repo.issues.set(number, issue);
  return { ok: true, value: issue };
}

export function issueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parts = parseGlobalId(id);
  if (parts === null || parts[0] !== 'Issue' || parts.length !== 3) return null;
  const dbId = Number(parts[1]);
  const number = Number(parts[2]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of store.repos.values()) {
    if (repo.dbId === dbId) {
      const issue = repo.issues.get(number);
      if (issue !== undefined) return { repo, issue };
      return null;
    }
  }
  return null;
}

export function createLabel(
  repo: Repo,
  body: { name?: unknown; color?: unknown; description?: unknown },
): Result<Label> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') return { ok: false, error: err(422, 'Validation Failed: name is required') };
  const label: Label = {
    name,
    color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'd73a4a',
    description: typeof body.description === 'string' ? body.description : '',
  };
  repo.labels.set(name, label);
  return { ok: true, value: label };
}

export function commentJson(comment: Comment, repo: Repo, number: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: comment.user, id: comment.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments/${comment.id}`,
  };
}

export function createComment(repo: Repo, number: number, bodyText: string): Result<Comment> {
  if (!repo.issues.has(number) && !repo.pulls.has(number)) {
    return { ok: false, error: err(404, 'Not Found') };
  }
  const id = repo.nextCommentId;
  repo.nextCommentId += 1;
  const comment: Comment = {
    id,
    globalId: globalId('IssueComment', repo.dbId, id),
    body: bodyText,
    user: VIEWER.login,
    createdAt: FIXED_STAMP,
  };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  // A comment changes the issue's cached JSON (its comment count).
  const issue = repo.issues.get(number);
  if (issue !== undefined) issue.jsonCache = undefined;
  return { ok: true, value: comment };
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: { login: pull.user, id: pull.user === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, type: 'User' },
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, type: 'User' },
      repo: repoJson(repo),
    },
  };
}

/** Split "owner:branch" into the branch name (the owner is always this repo's). */
function branchNameOf(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

export function createPull(
  repo: Repo,
  body: { title?: unknown; body?: unknown; head?: unknown; base?: unknown },
): Result<Pull> {
  const title = typeof body.title === 'string' ? body.title : '';
  const headRaw = typeof body.head === 'string' ? body.head : '';
  const baseRaw = typeof body.base === 'string' ? body.base : '';
  if (title === '' || headRaw === '' || baseRaw === '') {
    return { ok: false, error: err(422, 'Validation Failed: title, head and base are required') };
  }
  const headRef = branchNameOf(headRaw);
  const baseRef = branchNameOf(baseRaw);
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (headSha === '') return { ok: false, error: err(422, `Validation Failed: head branch "${headRef}" does not exist`) };
  if (baseSha === '') return { ok: false, error: err(422, `Validation Failed: base branch "${baseRef}" does not exist`) };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef) {
      return { ok: false, error: err(422, `Validation Failed: a pull request already exists for ${headRef}`) };
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    id: globalId('PullRequest', repo.dbId, number),
    number,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    baseShaAtCreate: baseSha,
    user: VIEWER.login,
    createdAt: FIXED_STAMP,
    updatedAt: FIXED_STAMP,
  };
  repo.pulls.set(number, pull);
  return { ok: true, value: pull };
}

export function pullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const parts = parseGlobalId(id);
  if (parts === null || parts[0] !== 'PullRequest' || parts.length !== 3) return null;
  const dbId = Number(parts[1]);
  const number = Number(parts[2]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of store.repos.values()) {
    if (repo.dbId === dbId) {
      const pull = repo.pulls.get(number);
      if (pull !== undefined) return { repo, pull };
      return null;
    }
  }
  return null;
}

/** Line counts for a file diff: set-based, enough for additions >= 1 checks. */
function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const trim = (lines: string[]): string[] => {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  };
  const oldSet = new Map<string, number>();
  for (const line of trim(oldLines)) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  const newSet = new Map<string, number>();
  for (const line of trim(newLines)) newSet.set(line, (newSet.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newSet) additions += Math.max(0, count - (oldSet.get(line) ?? 0));
  for (const [line, count] of oldSet) deletions += Math.max(0, count - (newSet.get(line) ?? 0));
  return { additions, deletions };
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The files a pull request changes: base-tip tree vs head-tip tree. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const baseFlat = flattenTree(repo, commitTree(repo, pull.baseSha));
  const headFlat = flattenTree(repo, commitTree(repo, pull.headSha));
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base === undefined && head !== undefined) {
      const blob = repo.objects.get(head.oid);
      const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
      const counts = lineCounts('', text);
      out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions, sha: head.oid });
    } else if (base !== undefined && head === undefined) {
      const blob = repo.objects.get(base.oid);
      const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
      const counts = lineCounts(text, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions, sha: base.oid });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const oldBlob = repo.objects.get(base.oid);
      const newBlob = repo.objects.get(head.oid);
      const oldText = oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8') : '';
      const newText = newBlob?.type === 'blob' ? newBlob.data.toString('utf8') : '';
      const counts = lineCounts(oldText, newText);
      out.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: head.oid,
      });
    }
  }
  return out;
}

/** The three-way conflict test: a file both sides changed differently. */
export function pullConflict(repo: Repo, pull: Pull): string | null {
  const createBaseFlat = flattenTree(repo, commitTree(repo, pull.baseShaAtCreate));
  // The base as it stands now: a merge that landed after this PR was opened
  // still conflicts with the head when it touched the same file.
  const currentBaseTip = branchTip(repo, pull.baseRef);
  const currentBaseFlat = flattenTree(repo, commitTree(repo, currentBaseTip));
  const headFlat = flattenTree(repo, commitTree(repo, pull.headSha));
  const paths = new Set([...createBaseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const atCreate = createBaseFlat.get(path);
    const head = headFlat.get(path);
    const headChanged = (atCreate?.oid ?? null) !== (head?.oid ?? null);
    if (!headChanged) continue;
    const current = currentBaseFlat.get(path);
    const baseChanged = (atCreate?.oid ?? null) !== (current?.oid ?? null);
    if (!baseChanged) continue;
    if ((current?.oid ?? null) === (head?.oid ?? null)) continue;
    return path;
  }
  return null;
}

/**
 * Squash-merge a pull request: one commit on the base branch whose tree is the
 * three-way merge (the head's changes applied onto the current base tip).
 */
export function mergePull(repo: Repo, pull: Pull): Result<{ sha: string; message: string }> {
  if (pull.state !== 'open') {
    return { ok: false, error: err(405, 'Validation Failed: pull request is already closed') };
  }
  const conflict = pullConflict(repo, pull);
  if (conflict !== null) {
    return { ok: false, error: err(405, `Merge conflict: ${conflict} was changed on both sides`) };
  }
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === '') return { ok: false, error: err(404, 'Not Found') };
  const createBaseFlat = flattenTree(repo, commitTree(repo, pull.baseShaAtCreate));
  const currentBaseFlat = flattenTree(repo, commitTree(repo, baseTip));
  const headFlat = flattenTree(repo, commitTree(repo, pull.headSha));
  const result = new Map(currentBaseFlat);
  for (const path of new Set([...createBaseFlat.keys(), ...headFlat.keys()])) {
    const atCreate = createBaseFlat.get(path);
    const head = headFlat.get(path);
    if ((atCreate?.oid ?? null) === (head?.oid ?? null)) continue;
    if (head === undefined) result.delete(path);
    else result.set(path, head);
  }
  const treeOid = buildTreeFromFlat(repo, result);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const commit = buildCommit(treeOid, [baseTip], message);
  const commitOid = gitOid('commit', commit.data);
  repo.objects.set(commitOid, commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_STAMP;
  pull.mergeCommitSha = commitOid;
  pull.baseSha = commitOid;
  pull.updatedAt = FIXED_STAMP;
  return { ok: true, value: { sha: commitOid, message: `Pull request #${pull.number} merged` } };
}

// ---------------------------------------------------------------------------
// object helpers for the git layer
// ---------------------------------------------------------------------------

/** Peel a tag object to the commit it points at (following tag chains). */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return current;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return current;
  }
  return current;
}

/** The refs of a repo, in git's advertisement order: HEAD first, then heads, tags. */
export function listRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string; unborn?: boolean }> {
  const out: Array<{ name: string; oid: string; peeled?: string; unborn?: boolean }> = [];
  const tip = defaultTip(repo);
  if (tip === '') {
    out.push({ name: 'HEAD', oid: ZERO_OID, unborn: true });
    out.push({ name: `refs/heads/${repo.defaultBranch}`, oid: ZERO_OID, unborn: true });
    return out;
  }
  out.push({ name: 'HEAD', oid: tip });
  const heads: string[] = [];
  const tags: string[] = [];
  for (const name of repo.refs.keys()) {
    if (name.startsWith('refs/heads/')) heads.push(name);
    else if (name.startsWith('refs/tags/')) tags.push(name);
  }
  heads.sort();
  tags.sort();
  for (const name of heads) {
    out.push({ name, oid: repo.refs.get(name)! });
  }
  for (const name of tags) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      out.push({ name, oid, peeled: peelToCommit(repo, oid) });
    } else {
      out.push({ name, oid });
    }
  }
  return out;
}
