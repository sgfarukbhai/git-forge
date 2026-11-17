// http-util.ts — the small request/response plumbing every surface shares.
//
// One Ctx per request: the parsed path, query, raw body and (when the body is
// JSON) the parsed value. Every REST reply is application/json and carries a
// non-empty X-GitHub-Request-Id; the git and MCP routes reuse the same sender
// for their JSON errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Store } from './store.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  /** The parsed JSON body, or undefined when there is none / it is not JSON. */
  json: unknown;
  /** True when a JSON body was sent but did not parse. */
  jsonError: boolean;
  requestId: string;
  host: string;
}

/** The path of a request URL, or '/' when it does not parse. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Split a path into segments, dropping empty ones and a trailing slash. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((part) => part !== '');
}

/** Parse the query string of a request URL. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Answer with a JSON body (a trailing newline, like GitHub). */
export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(text);
}

/** Answer with an already-serialized JSON string. */
export function sendJsonText(ctx: Ctx, status: number, text: string, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(text);
}

/** Answer with no body (204). */
export function sendNoContent(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, { 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

/** A JSON 404 with a string message. */
export function sendNotFound(ctx: Ctx, message = 'Not Found'): void {
  sendJson(ctx, 404, { message });
}

/** A JSON error with a string message. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/**
 * The bearer gate: a request without `Authorization: Bearer <token>` is 401.
 * Any non-empty bearer token is accepted — the suite mints its own token, and
 * the server cannot verify it against GitHub; the token names the viewer.
 */
export function requireAuth(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization ?? '';
  if (/^Bearer\s+\S+$/.test(header)) return true;
  sendJson(ctx, 401, { message: 'Requires authentication' });
  return false;
}

/** The token owner's login (the viewer), for repository ownership. */
export function viewerLogin(): string {
  return VIEWER.login;
}

/** Parse ?page and ?per_page (GitHub defaults: page 1, 30 per page, max 100). */
export function pagination(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

/**
 * Slice a list for the page and build the Link header (rel="next" and
 * rel="last") when there are more pages. The URLs are absolute, same-origin.
 */
export function paginate<T>(
  ctx: Ctx,
  items: readonly T[],
): { page: T[]; link: string | null } {
  const { page, perPage } = pagination(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (page >= totalPages) return { page: slice, link: null };
  const base = `http://${ctx.host}${ctx.path}`;
  const next = `${base}?${new URLSearchParams({ ...Object.fromEntries(ctx.query), page: String(page + 1), per_page: String(perPage) }).toString()}`;
  const last = `${base}?${new URLSearchParams({ ...Object.fromEntries(ctx.query), page: String(totalPages), per_page: String(perPage) }).toString()}`;
  return { page: slice, link: `<${next}>; rel="next", <${last}>; rel="last"` };
}
