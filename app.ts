// app.ts — the HTTP server: one Store, one router.
//
// Routes:
//   GET  /healthz                         the env's boot probe: 200 {"ok":true}
//   GET  /api/v3/                         the API root (no auth)
//   /api/v3/...                           REST v3 (rest.ts)
//   POST /api/graphql                     GraphQL v4 (graphql.ts)
//   POST /mcp                             MCP over Streamable HTTP (mcp.ts)
//   /<owner>/<repo>.git/info/refs        git smart HTTP advertisements
//   /<owner>/<repo>.git/git-upload-pack   git smart HTTP fetch
//   /<owner>/<repo>.git/git-receive-pack git smart HTTP push
//   anything else                         404 {"message":"Not Found"}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, readBody } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { pathOf, queryOf, sendJson, splitPath, type Ctx } from './http-util.ts';

let requestCounter = 0;

/** Parse a request body as JSON when it claims to be JSON. */
function parseJsonBody(body: Buffer): { json: unknown; jsonError: boolean } {
  if (body.length === 0) return { json: undefined, jsonError: false };
  try {
    return { json: JSON.parse(body.toString('utf8')) as unknown, jsonError: false };
  } catch {
    return { json: undefined, jsonError: true };
  }
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${++requestCounter}`;
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const segments = splitPath(path);
      try {
        // The boot probe: 200 {"ok":true}, twice, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(
            { req, res, store, method, path, segments, query: queryOf(req), body: Buffer.alloc(0), json: undefined, jsonError: false, requestId, host: req.headers.host ?? '' },
            200,
            { ok: true },
          );
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);
        const isGitRoute = segments.length >= 2 && segments[1]!.endsWith('.git');
        const parsed = isGitRoute ? { json: undefined, jsonError: false } : parseJsonBody(body);
        const ctx: Ctx = {
          req,
          res,
          store,
          method,
          path,
          segments,
          query: queryOf(req),
          body,
          json: parsed.json,
          jsonError: parsed.jsonError,
          requestId,
          host: req.headers.host ?? '',
        };

        if (handleMcp(ctx)) return;
        if (handleGraphQL(ctx)) return;
        if (handleRest(ctx)) return;

        // Git smart HTTP: /<owner>/<repo>.git/<service>.
        if (isGitRoute && segments.length >= 3) {
          const owner = decodeURIComponent(segments[0]!);
          const repoName = decodeURIComponent(segments[1]!.slice(0, -'.git'.length));
          const service = segments[2]!;
          if (service === 'info' && segments[3] === 'refs' && method === 'GET') {
            const wanted = ctx.query.get('service') ?? '';
            if (wanted === 'git-upload-pack' || wanted === 'git-receive-pack') {
              handleInfoRefs(req, res, store, owner, repoName, wanted);
              return;
            }
            sendJson(ctx, 404, { message: 'Not Found' });
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            handleUploadPack(req, res, store, owner, repoName, body);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            handleReceivePack(req, res, store, owner, repoName, body);
            return;
          }
        }

        sendJson(ctx, 404, { message: 'Not Found' });
      } catch (error) {
        try {
          process.stderr.write(`[forge] request ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}\n`);
          if (!res.writableEnded) {
            const text = `${JSON.stringify({ message: 'Internal Server Error' })}\n`;
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
            res.end(text);
          }
        } catch {
          // The connection is already gone; nothing left to do.
        }
      }
    })();
  });
}
