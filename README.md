# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sgfarukbhai/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sgfarukbhai/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP (upload-pack protocol v2, receive-pack v0), REST v3, GraphQL v4 and MCP over Streamable HTTP, all served from one in-memory store with no git binary, no database and no network beyond the trial env.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, then polls `/done` until the trial ends and exits 0. `main.ts` is the lifecycle; `app.ts` is the server.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, the API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges, git refs |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, plus `__type` introspection |
| `POST /mcp` | Model Context Protocol, revision 2026-07-28 (`server/discover`) with the 2025-11-25 handshake era as fallback |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

Every REST reply is `application/json` with a non-empty `X-GitHub-Request-Id`; a request without a bearer token is 401; a malformed JSON body is 400. A repository belongs to the login the token names, so the same name under another owner is 404, never 403.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done, exit 0).
- `app.ts` — the HTTP server and router.
- `store.ts` — the in-memory store and the git primitives: pkt-line codec, packfile read/write with OFS/REF delta resolution, tree and commit builders.
- `domain.ts` — the domain operations (repositories, refs, contents, issues, labels, comments, pull requests, merges) shared by REST, GraphQL and MCP, so the three surfaces always agree.
- `git-http.ts` — git smart HTTP: v2 capability advertisement and ls-refs/fetch, v0 advertisements and fetch, receive-pack with fast-forward checks and the report-status stream.
- `rest.ts` — the REST v3 routes.
- `graphql.ts` — the GraphQL parser, executor and introspection table.
- `mcp.ts` — the MCP endpoint and its seven tools.
- `http-util.ts` — the request/response plumbing every surface shares.

## Determinism

There is no clock and no randomness in state: every timestamp and identity the server writes is fixed (commits use `Conformance <conformance@make.fun>` at 1700000000 +0000; resources stamp `2026-11-14T06:30:00Z`). Two runs on the same requests leave the same state.

## Tests

The kit's own suite grades the entry locally:

```sh
node --experimental-strip-types main.ts   # in one shell, with MAKEFUN_ENV_URL set
node --experimental-strip-types <kit>/program/env/src/sdk/run.ts --url http://127.0.0.1:<port> --token <token> --perf --json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sgfarukbhai&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
