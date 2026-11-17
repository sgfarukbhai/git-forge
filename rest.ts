// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id; a
// request without a bearer token is 401; an unknown route is a JSON 404; a
// malformed JSON body is a JSON 400. A repository belongs to the login the
// token names, so the same name under another owner is 404, never 403.

import {
  branchTip,
  commentJson,
  createComment,
  createIssue,
  createLabel,
  createPull,
  createRef,
  createRepo,
  deleteContent,
  issueJson,
  listCommits,
  mergePull,
  pullFiles,
  pullJson,
  putContent,
  readContent,
  repoJson,
} from './domain.ts';
import { VIEWER, type Repo } from './store.ts';
import {
  paginate,
  requireAuth,
  sendError,
  sendJson,
  sendJsonText,
  sendNoContent,
  sendNotFound,
  viewerLogin,
  type Ctx,
} from './http-util.ts';

type Body = Record<string, unknown>;

function bodyOf(ctx: Ctx): Body {
  return (ctx.json !== undefined && typeof ctx.json === 'object' && ctx.json !== null ? ctx.json : {}) as Body;
}

/** The repository a route names, or a 404 already sent. */
function repoOf(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendNotFound(ctx);
    return null;
  }
  return repo;
}

/** A page of items as JSON, with the Link header when there is a next page. */
function sendPage<T>(ctx: Ctx, items: readonly T[], toJson: (item: T) => unknown): void {
  const { page, link } = paginate(ctx, items);
  sendJson(ctx, 200, page.map(toJson), link !== null ? { link } : {});
}

/** Sort issues/pulls by number, the creation-order proxy (all stamps are fixed). */
function sortByNumber<T extends { number: number }>(items: T[], direction: string): T[] {
  const out = [...items];
  out.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  return out;
}

/** The REST entry point: dispatch on method + segments. Returns true when handled. */
export function handleRest(ctx: Ctx): boolean {
  const seg = ctx.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const rest = seg.slice(2);
  const method = ctx.method;

  // The API root: 200 with the token's scopes, no auth needed (as the starter).
  if (rest.length === 0) {
    if (method !== 'GET') {
      sendNotFound(ctx);
      return true;
    }
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (!requireAuth(ctx)) return true;
  if (ctx.jsonError) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }

  // GET /api/v3/meta — 200 with a non-empty installed_version.
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      sendNotFound(ctx);
      return true;
    }
    sendJson(ctx, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      github_services_sha: '0000000000000000000000000000000000000000',
      hooks: ['pre-receive', 'post-receive'],
      git: ['1.0.0'],
    });
    return true;
  }

  // GET /api/v3/user — the token's login.
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(ctx, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64'),
      avatar_url: '',
      type: 'User',
      name: VIEWER.name,
      email: VIEWER.email,
      html_url: `https://example.invalid/${VIEWER.login}`,
      url: '/api/v3/user',
    });
    return true;
  }

  // /api/v3/user/repos — list / create.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      sendPage(ctx, ctx.store.reposOf(viewerLogin()), (repo) => repoJson(repo));
      return true;
    }
    if (method === 'POST') {
      const result = createRepo(ctx.store, viewerLogin(), bodyOf(ctx));
      if (!result.ok) {
        sendError(ctx, result.error.status, result.error.message);
        return true;
      }
      sendJson(ctx, 201, repoJson(result.value));
      return true;
    }
    sendNotFound(ctx);
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    return handleRepoRoute(ctx, rest.slice(1));
  }

  sendNotFound(ctx);
  return true;
}

function handleRepoRoute(ctx: Ctx, rest: string[]): boolean {
  const method = ctx.method;
  const owner = decodeURIComponent(rest[0]!);
  const name = decodeURIComponent(rest[1]!);
  const tail = rest.slice(2);

  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = repoOf(ctx, owner, name);
      if (repo !== null) sendJson(ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = repoOf(ctx, owner, name);
      if (repo === null) return true;
      const body = bodyOf(ctx);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = repoOf(ctx, owner, name);
      if (repo === null) return true;
      ctx.store.repos.delete(`${owner}/${name}`);
      sendNoContent(ctx, 204);
      return true;
    }
    sendNotFound(ctx);
    return true;
  }

  const repo = repoOf(ctx, owner, name);
  if (repo === null) return true;
  const resource = tail[0]!;

  // Branches.
  if (resource === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
      sendJson(ctx, 200, list);
      return true;
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(tail[1]!);
      const sha = branchTip(repo, branch);
      if (sha === '') {
        sendNotFound(ctx);
        return true;
      }
      sendJson(ctx, 200, { name: branch, commit: { sha }, sha, protected: false });
      return true;
    }
    sendNotFound(ctx);
    return true;
  }

  // Commits.
  if (resource === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const result = listCommits(repo, ref);
    if (!result.ok) {
      sendError(ctx, result.error.status, result.error.message);
      return true;
    }
    sendJson(ctx, 200, result.value);
    return true;
  }

  // Contents.
  if (resource === 'contents') {
    const path = tail.slice(1).map(decodeURIComponent).join('/');
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? undefined;
      const result = readContent(repo, path, ref);
      if (!result.ok) {
        sendError(ctx, result.error.status, result.error.message);
        return true;
      }
      if ('file' in result.value) {
        const file = result.value.file;
        sendJson(ctx, 200, {
          type: 'file',
          encoding: 'base64',
          size: file.size,
          name: file.path.split('/').pop(),
          path: file.path,
          content: file.contentB64,
          sha: file.sha,
        });
        return true;
      }
      sendJson(ctx, 200, result.value.dir);
      return true;
    }
    if (method === 'PUT') {
      const result = putContent(repo, path, bodyOf(ctx));
      if (!result.ok) {
        sendError(ctx, result.error.status, result.error.message);
        return true;
      }
      const content = result.value.content;
      sendJson(ctx, result.value.created ? 201 : 200, {
        content: {
          name: content.path.split('/').pop(),
          path: content.path,
          sha: content.sha,
          size: content.size,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: result.value.commitSha },
      });
      return true;
    }
    if (method === 'DELETE') {
      const result = deleteContent(repo, path, bodyOf(ctx));
      if (!result.ok) {
        sendError(ctx, result.error.status, result.error.message);
        return true;
      }
      sendJson(ctx, 200, { commit: { sha: result.value.commitSha } });
      return true;
    }
    sendNotFound(ctx);
    return true;
  }

  // Labels.
  if (resource === 'labels') {
    if (tail.length === 1 && method === 'GET') {
      sendJson(ctx, 200, [...repo.labels.values()]);
      return true;
    }
    if (tail.length === 1 && method === 'POST') {
      const result = createLabel(repo, bodyOf(ctx));
      if (!result.ok) {
        sendError(ctx, result.error.status, result.error.message);
        return true;
      }
      sendJson(ctx, 201, result.value);
      return true;
    }
    sendNotFound(ctx);
    return true;
  }

  // Issues.
  if (resource === 'issues') {
    if (tail.length === 1 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      sendPage(ctx, sortByNumber(list, direction), (issue) => issueJson(issue, repo));
      return true;
    }
    if (tail.length === 1 && method === 'POST') {
      const result = createIssue(repo, bodyOf(ctx));
      if (!result.ok) {
        sendError(ctx, result.error.status, result.error.message);
        return true;
      }
      sendJson(ctx, 201, issueJson(result.value, repo));
      return true;
    }
    const number = Number(tail[1]);
    if (tail.length >= 2 && Number.isInteger(number)) {
      const issue = repo.issues.get(number);
      if (tail.length === 2 && method === 'GET') {
        if (issue === undefined) {
          sendNotFound(ctx);
          return true;
        }
        // The serialized form is cached: a read varies only in the request id.
        if (issue.jsonCache === undefined) issue.jsonCache = `${JSON.stringify(issueJson(issue, repo))}\n`;
        sendJsonText(ctx, 200, issue.jsonCache);
        return true;
      }
      if (tail.length === 2 && method === 'PATCH') {
        if (issue === undefined) {
          sendNotFound(ctx);
          return true;
        }
        const body = bodyOf(ctx);
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        issue.jsonCache = undefined;
        sendJson(ctx, 200, issueJson(issue, repo));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') {
          const list = (repo.comments.get(number) ?? []).map((c) => commentJson(c, repo, number));
          sendPage(ctx, list, (item) => item);
          return true;
        }
        if (method === 'POST') {
          const body = bodyOf(ctx);
          const text = typeof body.body === 'string' ? body.body : '';
          if (text === '') {
            sendError(ctx, 422, 'Validation Failed: body is required');
            return true;
          }
          const result = createComment(repo, number, text);
          if (!result.ok) {
            sendError(ctx, result.error.status, result.error.message);
            return true;
          }
          sendJson(ctx, 201, commentJson(result.value, repo, number));
          return true;
        }
        sendNotFound(ctx);
        return true;
      }
    }
    sendNotFound(ctx);
    return true;
  }

  // Pull requests.
  if (resource === 'pulls') {
    if (tail.length === 1 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      sendPage(ctx, sortByNumber(list, 'desc'), (pull) => pullJson(pull, repo));
      return true;
    }
    if (tail.length === 1 && method === 'POST') {
      const result = createPull(repo, bodyOf(ctx));
      if (!result.ok) {
        sendError(ctx, result.error.status, result.error.message);
        return true;
      }
      sendJson(ctx, 201, pullJson(result.value, repo));
      return true;
    }
    const number = Number(tail[1]);
    if (tail.length >= 2 && Number.isInteger(number)) {
      const pull = repo.pulls.get(number);
      if (tail.length === 2 && method === 'GET') {
        if (pull === undefined) {
          sendNotFound(ctx);
          return true;
        }
        sendJson(ctx, 200, pullJson(pull, repo));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendNotFound(ctx);
          return true;
        }
        sendJson(ctx, 200, pullFiles(repo, pull));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendNotFound(ctx);
          return true;
        }
        const result = mergePull(repo, pull);
        if (!result.ok) {
          sendError(ctx, result.error.status, result.error.message);
          return true;
        }
        sendJson(ctx, 200, { sha: result.value.sha, merged: true, message: result.value.message });
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments' && method === 'GET') {
        const list = (repo.comments.get(number) ?? []).map((c) => commentJson(c, repo, number));
        sendJson(ctx, 200, list);
        return true;
      }
    }
    sendNotFound(ctx);
    return true;
  }

  // Git Data: refs.
  if (resource === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = bodyOf(ctx);
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      const result = createRef(repo, ref, sha);
      if (!result.ok) {
        sendError(ctx, result.error.status, result.error.message);
        return true;
      }
      sendJson(ctx, 201, { ref: result.value.ref, object: { sha: result.value.sha, type: 'commit' } });
      return true;
    }
    if (method === 'GET') {
      if (tail.length === 2) {
        const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        sendJson(ctx, 200, list);
        return true;
      }
      const refName = tail.slice(2).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(refName);
      if (sha === undefined) {
        sendNotFound(ctx);
        return true;
      }
      const obj = repo.objects.get(sha);
      sendJson(ctx, 200, { ref: refName, object: { sha, type: obj?.type ?? 'commit' } });
      return true;
    }
    sendNotFound(ctx);
    return true;
  }

  sendNotFound(ctx);
  return true;
}
