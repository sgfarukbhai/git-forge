// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp.
//
// The modern era (revision 2026-07-28): server/discover answers the identity,
// capabilities and supported versions in one request, no handshake, no
// session. The legacy era (2025-11-25 and earlier) is answered too, through
// initialize + notifications/initialized. Every request is one plain JSON
// body answered by one plain JSON body; each request answers inside 3 s.
//
// The tools act on the same store as REST: a repository or issue created over
// MCP reads back over /api/v3 as the same object, ids unchanged.

import {
  createIssue,
  createPull,
  createRepo,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
} from './domain.ts';
import { VIEWER } from './store.ts';
import { sendJson, type Ctx } from './http-util.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Run one tools/call. Returns a tool result object (isError on failure). */
function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return toolError(`Unknown tool: ${name}`);
  const missing = def.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.name ?? '');
  switch (name) {
    case 'create_repo': {
      const result = createRepo(ctx.store, VIEWER.login, {
        name: args.name,
        description: args.description,
        private: args.private,
      });
      if (!result.ok) return toolError(result.error.message);
      return toolResult(repoJson(result.value));
    }
    case 'get_repo': {
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const result = createIssue(repo, { title: args.title, body: args.body });
      if (!result.ok) return toolError(result.error.message);
      return toolResult(issueJson(result.value, repo));
    }
    case 'list_issues': {
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.number - a.number);
      return toolResult(list.map((issue) => issueJson(issue, repo)));
    }
    case 'create_pull_request': {
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const result = createPull(repo, { title: args.title, body: args.body, head: args.head, base: args.base });
      if (!result.ok) return toolError(result.error.message);
      return toolResult(pullJson(result.value, repo));
    }
    case 'merge_pull_request': {
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError(`Pull request #${String(args.pull_number)} not found`);
      const result = mergePull(repo, pull);
      if (!result.ok) return toolError(result.error.message);
      return toolResult({ merged: true, sha: result.value.sha, message: result.value.message, number: pull.number });
    }
    case 'get_issue': {
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolError(`Issue #${String(args.issue_number)} not found`);
      return toolResult(issueJson(issue, repo));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleMcp(ctx: Ctx): boolean {
  if (ctx.segments.join('/') !== 'mcp') return false;
  if (ctx.method === 'DELETE') {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return true;
  }
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, { message: 'Method Not Allowed' });
    return true;
  }
  // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
  if (ctx.jsonError || ctx.json === undefined) {
    sendJson(ctx, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  const body = ctx.json;
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(ctx, 400, rpcError(isRecord(body) ? body.id : null, -32600, 'Invalid Request'));
    return true;
  }
  const id = body.id ?? null;
  const method = body.method as string;
  // Notifications carry no id and are answered 202 with an empty body.
  if (id === null && method.startsWith('notifications/')) {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return true;
  }
  // Authentication is decided before any tool exists: no bearer token is 401.
  const header = ctx.req.headers.authorization ?? '';
  if (!/^Bearer\s+\S+$/.test(header)) {
    sendJson(ctx, 401, rpcError(id, -32001, 'Requires authentication'));
    return true;
  }
  const params = isRecord(body.params) ? body.params : {};
  switch (method) {
    case 'server/discover': {
      sendJson(ctx, 200, rpcResult(id, {
        resultType: 'discover',
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: { listChanged: false } },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }));
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : LEGACY_REVISIONS[0]!;
      sendJson(ctx, 200, rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }));
      return true;
    }
    case 'ping': {
      sendJson(ctx, 200, rpcResult(id, {}));
      return true;
    }
    case 'tools/list': {
      sendJson(ctx, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (TOOLS.find((tool) => tool.name === name) === undefined) {
        sendJson(ctx, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
        return true;
      }
      const result = callTool(ctx, name, args);
      sendJson(ctx, 200, rpcResult(id, result));
      return true;
    }
    default: {
      sendJson(ctx, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return true;
    }
  }
}
