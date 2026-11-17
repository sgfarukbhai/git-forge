// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send.
//
// A hand-rolled recursive-descent parser and executor for the query language
// subset the suite uses: operations, variables, aliases, arguments (literals,
// variables, input objects, enums, lists), inline and named fragments,
// __typename and __type introspection, batched bodies (an array answers an
// array, in order). Unknown fields are HTTP 200 with an errors array naming
// the field; an unknown repository is data.repository = null with no errors.

import {
  createComment,
  createIssue,
  createPull,
  issueByGlobalId,
  mergePull,
  pullByGlobalId,
  pullConflict,
  pullFiles,
  type Pull,
} from './domain.ts';
import { VIEWER, type Issue, type Repo, type Store } from './store.ts';
import { requireAuth, sendError, sendJson, type Ctx } from './http-util.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

class Lexer {
  pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  private peekChar(): string {
    return this.src[this.pos] ?? '';
  }

  private nextChar(): string {
    return this.src[this.pos++] ?? '';
  }

  /** Skip whitespace, commas and # comments. */
  skipIgnored(): void {
    for (;;) {
      const ch = this.peekChar();
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  /** The next token's text, or '' at the end. */
  peekToken(): string {
    this.skipIgnored();
    const ch = this.peekChar();
    if (ch === '') return '';
    if ('{}():$!=@[]'.includes(ch)) return ch;
    if (this.src.startsWith('...', this.pos)) return '...';
    if (ch === '"') {
      let i = this.pos + 1;
      while (i < this.src.length) {
        if (this.src[i] === '\\') {
          i += 2;
          continue;
        }
        if (this.src[i] === '"') break;
        i += 1;
      }
      return this.src.slice(this.pos, i + 1);
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (match !== null) return match[0];
    const num = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.src.slice(this.pos));
    if (num !== null) return num[0];
    return ch;
  }

  nextToken(): string {
    const token = this.peekToken();
    this.pos += token.length;
    return token;
  }

  expect(token: string): void {
    const got = this.nextToken();
    if (got !== token) throw new ParseError(`expected ${token}, got ${JSON.stringify(got)}`);
  }

  /** A name token, or '' when the next token is not a name. */
  nextName(): string {
    const token = this.peekToken();
    if (/^[A-Za-z_]/.test(token) && !token.startsWith('"')) {
      this.pos += token.length;
      return token;
    }
    return '';
  }
}

function parseStringToken(token: string): string {
  const inner = token.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const esc = inner[++i]!;
    switch (esc) {
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '/':
        out += '/';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'u':
        out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
        i += 4;
        break;
      default:
        out += esc;
    }
  }
  return out;
}

class Parser {
  private readonly lexer: Lexer;

  constructor(src: string) {
    this.lexer = new Lexer(src);
  }

  parseDocument(): Document {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    for (;;) {
      this.lexer.skipIgnored();
      if (this.lexer.peekToken() === '') break;
      const token = this.lexer.peekToken();
      if (token === 'fragment') {
        this.lexer.nextToken();
        const name = this.lexer.nextName();
        if (name === '') throw new ParseError('fragment needs a name');
        this.lexer.expect('on');
        const typeCondition = this.lexer.nextName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    const token = this.lexer.peekToken();
    if (token === 'query' || token === 'mutation') {
      this.lexer.nextToken();
      operation = token;
    }
    let name: string | null = null;
    const maybeName = this.lexer.peekToken();
    if (maybeName !== '' && maybeName !== '(' && maybeName !== '{' && /^[A-Za-z_]/.test(maybeName)) {
      name = this.lexer.nextName();
    }
    const variables = this.parseVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { operation, name, variables, selections };
  }

  private parseVariableDefinitions(): Array<{ name: string; type: string; defaultValue: ValueNode | null }> {
    const out: Array<{ name: string; type: string; defaultValue: ValueNode | null }> = [];
    if (this.lexer.peekToken() !== '(') return out;
    this.lexer.nextToken();
    while (this.lexer.peekToken() !== ')') {
      this.lexer.expect('$');
      const name = this.lexer.nextName();
      this.lexer.expect(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.lexer.peekToken() === '=') {
        this.lexer.nextToken();
        defaultValue = this.parseValue();
      }
      out.push({ name, type, defaultValue });
    }
    this.lexer.expect(')');
    return out;
  }

  private parseType(): string {
    let type = '';
    if (this.lexer.peekToken() === '[') {
      this.lexer.nextToken();
      type = `[${this.parseType()}]`;
    } else {
      type = this.lexer.nextName();
    }
    if (this.lexer.peekToken() === '!') {
      this.lexer.nextToken();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.lexer.expect('{');
    const selections: SelectionNode[] = [];
    while (this.lexer.peekToken() !== '}') {
      selections.push(this.parseSelection());
    }
    this.lexer.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.lexer.peekToken() === '...') {
      this.lexer.nextToken();
      const token = this.lexer.peekToken();
      if (token === 'on') {
        this.lexer.nextToken();
        const typeCondition = this.lexer.nextName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.lexer.nextName();
      if (name === '') {
        // "... { ... }" — an inline fragment with no type condition.
        return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
      }
      return { kind: 'fragmentSpread', name };
    }
    const first = this.lexer.nextName();
    if (first === '') throw new ParseError('a selection needs a field name');
    let alias: string | null = null;
    let name = first;
    if (this.lexer.peekToken() === ':') {
      this.lexer.nextToken();
      alias = first;
      name = this.lexer.nextName();
    }
    const args = this.parseArguments();
    const selections = this.lexer.peekToken() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.lexer.peekToken() !== '(') return args;
    this.lexer.nextToken();
    while (this.lexer.peekToken() !== ')') {
      const name = this.lexer.nextName();
      this.lexer.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.lexer.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.lexer.peekToken();
    if (token === '$') {
      this.lexer.nextToken();
      return { kind: 'variable', name: this.lexer.nextName() };
    }
    if (token === '[') {
      this.lexer.nextToken();
      const values: ValueNode[] = [];
      while (this.lexer.peekToken() !== ']') values.push(this.parseValue());
      this.lexer.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      this.lexer.nextToken();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.lexer.peekToken() !== '}') {
        const name = this.lexer.nextName();
        this.lexer.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.lexer.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) {
      this.lexer.nextToken();
      return { kind: 'string', value: parseStringToken(token) };
    }
    if (/^-?[0-9]/.test(token)) {
      this.lexer.nextToken();
      if (/[.eE]/.test(token)) return { kind: 'float', value: Number(token) };
      return { kind: 'int', value: Number(token) };
    }
    if (token === 'true' || token === 'false') {
      this.lexer.nextToken();
      return { kind: 'boolean', value: token === 'true' };
    }
    if (token === 'null') {
      this.lexer.nextToken();
      return { kind: 'null' };
    }
    const name = this.lexer.nextName();
    if (name === '') throw new ParseError(`unexpected value ${JSON.stringify(token)}`);
    return { kind: 'enum', value: name };
  }
}

/** Resolve a value node against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// introspection table
// ---------------------------------------------------------------------------

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}

interface IntField {
  name: string;
  description: string | null;
  args: Array<{ name: string; description: string | null; type: TypeRef; defaultValue: string | null }>;
  type: TypeRef;
}

interface IntEnumValue {
  name: string;
  description: string | null;
  isDeprecated: boolean;
  deprecationReason: string | null;
}

interface IntType {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  name: string;
  description: string | null;
  fields: IntField[] | null;
  enumValues: IntEnumValue[] | null;
  inputFields: Array<{ name: string; description: string | null; type: TypeRef; defaultValue: string | null }> | null;
}

function ref(kind: string, name: string | null, ofType: TypeRef | null = null): TypeRef {
  return { kind, name, ofType };
}
function nn(t: TypeRef): TypeRef {
  return ref('NON_NULL', null, t);
}
function lst(t: TypeRef): TypeRef {
  return ref('LIST', null, t);
}
const T = {
  ID: ref('SCALAR', 'ID'),
  String: ref('SCALAR', 'String'),
  Int: ref('SCALAR', 'Int'),
  Boolean: ref('SCALAR', 'Boolean'),
  DateTime: ref('SCALAR', 'DateTime'),
};
function obj(name: string): TypeRef {
  return ref('OBJECT', name);
}
function enm(name: string): TypeRef {
  return ref('ENUM', name);
}
function inp(name: string): TypeRef {
  return ref('INPUT_OBJECT', name);
}
function field(name: string, type: TypeRef, args: IntField['args'] = []): IntField {
  return { name, description: null, args, type };
}
function arg(name: string, type: TypeRef): { name: string; description: string | null; type: TypeRef; defaultValue: string | null } {
  return { name, description: null, type, defaultValue: null };
}
function enumValue(name: string): IntEnumValue {
  return { name, description: null, isDeprecated: false, deprecationReason: null };
}

const INTROSPECTION: Record<string, IntType> = {
  Query: {
    kind: 'OBJECT',
    name: 'Query',
    description: null,
    fields: [
      field('viewer', nn(obj('User'))),
      field('repository', obj('Repository'), [arg('owner', nn(T.String)), arg('name', nn(T.String))]),
      field('node', obj('Node'), [arg('id', nn(T.ID))]),
    ],
    enumValues: null,
    inputFields: null,
  },
  Mutation: {
    kind: 'OBJECT',
    name: 'Mutation',
    description: null,
    fields: [
      field('createIssue', obj('CreateIssuePayload'), [arg('input', nn(inp('CreateIssueInput')))]),
      field('closeIssue', obj('CloseIssuePayload'), [arg('input', nn(inp('CloseIssueInput')))]),
      field('createPullRequest', obj('CreatePullRequestPayload'), [arg('input', nn(inp('CreatePullRequestInput')))]),
      field('mergePullRequest', obj('MergePullRequestPayload'), [arg('input', nn(inp('MergePullRequestInput')))]),
      field('addComment', obj('AddCommentPayload'), [arg('input', nn(inp('AddCommentInput')))]),
    ],
    enumValues: null,
    inputFields: null,
  },
  Repository: {
    kind: 'OBJECT',
    name: 'Repository',
    description: null,
    fields: [
      field('id', nn(T.ID)),
      field('databaseId', T.Int),
      field('name', nn(T.String)),
      field('nameWithOwner', nn(T.String)),
      field('owner', nn(obj('User'))),
      field('defaultBranchRef', obj('Ref')),
      field('viewerPermission', enm('RepositoryPermission')),
      field('hasIssuesEnabled', nn(T.Boolean)),
      field('description', T.String),
      field('private', nn(T.Boolean)),
      field('url', nn(T.String)),
      field('createdAt', nn(T.DateTime)),
      field('updatedAt', nn(T.DateTime)),
      field('issue', obj('Issue'), [arg('number', nn(T.Int))]),
      field('issues', nn(obj('IssueConnection')), [
        arg('first', T.Int),
        arg('after', T.String),
        arg('states', lst(enm('IssueState'))),
        arg('orderBy', inp('IssueOrder')),
      ]),
      field('pullRequest', obj('PullRequest'), [arg('number', nn(T.Int))]),
      field('pullRequests', nn(obj('PullRequestConnection')), [
        arg('first', T.Int),
        arg('after', T.String),
        arg('states', lst(enm('PullRequestState'))),
        arg('orderBy', inp('IssueOrder')),
      ]),
    ],
    enumValues: null,
    inputFields: null,
  },
  Issue: {
    kind: 'OBJECT',
    name: 'Issue',
    description: null,
    fields: [
      field('id', nn(T.ID)),
      field('number', nn(T.Int)),
      field('title', nn(T.String)),
      field('body', T.String),
      field('state', nn(enm('IssueState'))),
      field('createdAt', nn(T.DateTime)),
      field('updatedAt', nn(T.DateTime)),
      field('author', obj('User')),
      field('labels', obj('LabelConnection'), [arg('first', T.Int)]),
      field('comments', nn(obj('IssueCommentConnection')), [arg('first', T.Int), arg('after', T.String)]),
    ],
    enumValues: null,
    inputFields: null,
  },
  PullRequest: {
    kind: 'OBJECT',
    name: 'PullRequest',
    description: null,
    fields: [
      field('id', nn(T.ID)),
      field('number', nn(T.Int)),
      field('title', nn(T.String)),
      field('body', T.String),
      field('state', nn(enm('PullRequestState'))),
      field('merged', nn(T.Boolean)),
      field('mergeable', nn(enm('MergeableState'))),
      field('headRefName', nn(T.String)),
      field('baseRefName', nn(T.String)),
      field('headRef', obj('Ref')),
      field('baseRef', obj('Ref')),
      field('createdAt', nn(T.DateTime)),
      field('updatedAt', nn(T.DateTime)),
      field('mergedAt', T.DateTime),
      field('author', obj('User')),
      field('files', obj('PullRequestFileConnection'), [arg('first', T.Int), arg('after', T.String)]),
      field('commits', obj('PullRequestCommitConnection'), [arg('first', T.Int)]),
    ],
    enumValues: null,
    inputFields: null,
  },
  IssueComment: {
    kind: 'OBJECT',
    name: 'IssueComment',
    description: null,
    fields: [
      field('id', nn(T.ID)),
      field('body', nn(T.String)),
      field('author', obj('User')),
      field('createdAt', nn(T.DateTime)),
    ],
    enumValues: null,
    inputFields: null,
  },
  User: {
    kind: 'OBJECT',
    name: 'User',
    description: null,
    fields: [
      field('id', nn(T.ID)),
      field('login', nn(T.String)),
      field('name', T.String),
      field('avatarUrl', nn(T.String)),
    ],
    enumValues: null,
    inputFields: null,
  },
  Ref: {
    kind: 'OBJECT',
    name: 'Ref',
    description: null,
    fields: [field('name', nn(T.String)), field('id', nn(T.ID))],
    enumValues: null,
    inputFields: null,
  },
  IssueConnection: {
    kind: 'OBJECT',
    name: 'IssueConnection',
    description: null,
    fields: [
      field('nodes', lst(obj('Issue'))),
      field('edges', lst(obj('IssueEdge'))),
      field('pageInfo', nn(obj('PageInfo'))),
      field('totalCount', nn(T.Int)),
    ],
    enumValues: null,
    inputFields: null,
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    name: 'PullRequestConnection',
    description: null,
    fields: [
      field('nodes', lst(obj('PullRequest'))),
      field('edges', lst(obj('PullRequestEdge'))),
      field('pageInfo', nn(obj('PageInfo'))),
      field('totalCount', nn(T.Int)),
    ],
    enumValues: null,
    inputFields: null,
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    name: 'IssueCommentConnection',
    description: null,
    fields: [
      field('nodes', lst(obj('IssueComment'))),
      field('edges', lst(obj('IssueCommentEdge'))),
      field('pageInfo', nn(obj('PageInfo'))),
      field('totalCount', nn(T.Int)),
    ],
    enumValues: null,
    inputFields: null,
  },
  PullRequestFileConnection: {
    kind: 'OBJECT',
    name: 'PullRequestFileConnection',
    description: null,
    fields: [
      field('nodes', lst(obj('PullRequestFile'))),
      field('edges', lst(obj('PullRequestFileEdge'))),
      field('pageInfo', nn(obj('PageInfo'))),
      field('totalCount', nn(T.Int)),
    ],
    enumValues: null,
    inputFields: null,
  },
  PullRequestCommitConnection: {
    kind: 'OBJECT',
    name: 'PullRequestCommitConnection',
    description: null,
    fields: [field('nodes', lst(obj('PullRequestCommit'))), field('pageInfo', nn(obj('PageInfo'))), field('totalCount', nn(T.Int))],
    enumValues: null,
    inputFields: null,
  },
  LabelConnection: {
    kind: 'OBJECT',
    name: 'LabelConnection',
    description: null,
    fields: [field('nodes', lst(obj('Label'))), field('pageInfo', nn(obj('PageInfo'))), field('totalCount', nn(T.Int))],
    enumValues: null,
    inputFields: null,
  },
  IssueEdge: {
    kind: 'OBJECT',
    name: 'IssueEdge',
    description: null,
    fields: [field('node', obj('Issue')), field('cursor', nn(T.String))],
    enumValues: null,
    inputFields: null,
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    name: 'PullRequestEdge',
    description: null,
    fields: [field('node', obj('PullRequest')), field('cursor', nn(T.String))],
    enumValues: null,
    inputFields: null,
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    name: 'IssueCommentEdge',
    description: null,
    fields: [field('node', obj('IssueComment')), field('cursor', nn(T.String))],
    enumValues: null,
    inputFields: null,
  },
  PullRequestFileEdge: {
    kind: 'OBJECT',
    name: 'PullRequestFileEdge',
    description: null,
    fields: [field('node', obj('PullRequestFile')), field('cursor', nn(T.String))],
    enumValues: null,
    inputFields: null,
  },
  PullRequestFile: {
    kind: 'OBJECT',
    name: 'PullRequestFile',
    description: null,
    fields: [
      field('path', nn(T.String)),
      field('additions', nn(T.Int)),
      field('deletions', nn(T.Int)),
      field('changeType', nn(T.String)),
    ],
    enumValues: null,
    inputFields: null,
  },
  PullRequestCommit: {
    kind: 'OBJECT',
    name: 'PullRequestCommit',
    description: null,
    fields: [field('commit', obj('Commit'))],
    enumValues: null,
    inputFields: null,
  },
  Commit: {
    kind: 'OBJECT',
    name: 'Commit',
    description: null,
    fields: [field('oid', nn(T.String)), field('message', nn(T.String))],
    enumValues: null,
    inputFields: null,
  },
  Label: {
    kind: 'OBJECT',
    name: 'Label',
    description: null,
    fields: [field('id', nn(T.ID)), field('name', nn(T.String)), field('color', nn(T.String))],
    enumValues: null,
    inputFields: null,
  },
  PageInfo: {
    kind: 'OBJECT',
    name: 'PageInfo',
    description: null,
    fields: [
      field('hasNextPage', nn(T.Boolean)),
      field('hasPreviousPage', nn(T.Boolean)),
      field('startCursor', T.String),
      field('endCursor', T.String),
    ],
    enumValues: null,
    inputFields: null,
  },
  Node: {
    kind: 'OBJECT',
    name: 'Node',
    description: null,
    fields: [field('id', nn(T.ID))],
    enumValues: null,
    inputFields: null,
  },
  IssueState: {
    kind: 'ENUM',
    name: 'IssueState',
    description: null,
    fields: null,
    enumValues: [enumValue('OPEN'), enumValue('CLOSED')],
    inputFields: null,
  },
  PullRequestState: {
    kind: 'ENUM',
    name: 'PullRequestState',
    description: null,
    fields: null,
    enumValues: [enumValue('OPEN'), enumValue('CLOSED'), enumValue('MERGED')],
    inputFields: null,
  },
  MergeableState: {
    kind: 'ENUM',
    name: 'MergeableState',
    description: null,
    fields: null,
    enumValues: [enumValue('MERGEABLE'), enumValue('CONFLICTING'), enumValue('UNKNOWN')],
    inputFields: null,
  },
  RepositoryPermission: {
    kind: 'ENUM',
    name: 'RepositoryPermission',
    description: null,
    fields: null,
    enumValues: [enumValue('ADMIN'), enumValue('MAINTAIN'), enumValue('WRITE'), enumValue('TRIAGE'), enumValue('READ')],
    inputFields: null,
  },
  SearchType: {
    kind: 'ENUM',
    name: 'SearchType',
    description: null,
    fields: null,
    enumValues: [enumValue('ISSUE'), enumValue('DISCUSSION'), enumValue('PULL_REQUEST'), enumValue('REPOSITORY'), enumValue('USER'), enumValue('COMMIT'), enumValue('CODE')],
    inputFields: null,
  },
  IssueOrderField: {
    kind: 'ENUM',
    name: 'IssueOrderField',
    description: null,
    fields: null,
    enumValues: [enumValue('CREATED_AT'), enumValue('UPDATED_AT'), enumValue('COMMENTS')],
    inputFields: null,
  },
  OrderDirection: {
    kind: 'ENUM',
    name: 'OrderDirection',
    description: null,
    fields: null,
    enumValues: [enumValue('ASC'), enumValue('DESC')],
    inputFields: null,
  },
  MergeMethod: {
    kind: 'ENUM',
    name: 'MergeMethod',
    description: null,
    fields: null,
    enumValues: [enumValue('MERGE'), enumValue('SQUASH'), enumValue('REBASE')],
    inputFields: null,
  },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    name: 'IssueOrder',
    description: null,
    fields: null,
    enumValues: null,
    inputFields: [arg('field', nn(enm('IssueOrderField'))), arg('direction', nn(enm('OrderDirection')))],
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    name: 'CreateIssueInput',
    description: null,
    fields: null,
    enumValues: null,
    inputFields: [
      arg('repositoryId', nn(T.ID)),
      arg('title', nn(T.String)),
      arg('body', T.String),
      arg('clientMutationId', T.String),
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    name: 'CloseIssueInput',
    description: null,
    fields: null,
    enumValues: null,
    inputFields: [arg('issueId', nn(T.ID)), arg('clientMutationId', T.String)],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    name: 'CreatePullRequestInput',
    description: null,
    fields: null,
    enumValues: null,
    inputFields: [
      arg('repositoryId', nn(T.ID)),
      arg('baseRefName', nn(T.String)),
      arg('headRefName', nn(T.String)),
      arg('title', nn(T.String)),
      arg('body', T.String),
      arg('clientMutationId', T.String),
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    name: 'MergePullRequestInput',
    description: null,
    fields: null,
    enumValues: null,
    inputFields: [
      arg('pullRequestId', nn(T.ID)),
      arg('mergeMethod', enm('MergeMethod')),
      arg('clientMutationId', T.String),
    ],
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    name: 'AddCommentInput',
    description: null,
    fields: null,
    enumValues: null,
    inputFields: [arg('subjectId', nn(T.ID)), arg('body', nn(T.String)), arg('clientMutationId', T.String)],
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    name: 'CreateIssuePayload',
    description: null,
    fields: [field('issue', obj('Issue')), field('clientMutationId', T.String)],
    enumValues: null,
    inputFields: null,
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    name: 'CloseIssuePayload',
    description: null,
    fields: [field('issue', obj('Issue')), field('clientMutationId', T.String)],
    enumValues: null,
    inputFields: null,
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    name: 'CreatePullRequestPayload',
    description: null,
    fields: [field('pullRequest', obj('PullRequest')), field('clientMutationId', T.String)],
    enumValues: null,
    inputFields: null,
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    name: 'MergePullRequestPayload',
    description: null,
    fields: [field('pullRequest', obj('PullRequest')), field('clientMutationId', T.String)],
    enumValues: null,
    inputFields: null,
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    name: 'AddCommentPayload',
    description: null,
    fields: [field('commentEdge', obj('IssueCommentEdge')), field('clientMutationId', T.String)],
    enumValues: null,
    inputFields: null,
  },
  String: { kind: 'SCALAR', name: 'String', description: null, fields: null, enumValues: null, inputFields: null },
  Int: { kind: 'SCALAR', name: 'Int', description: null, fields: null, enumValues: null, inputFields: null },
  Boolean: { kind: 'SCALAR', name: 'Boolean', description: null, fields: null, enumValues: null, inputFields: null },
  ID: { kind: 'SCALAR', name: 'ID', description: null, fields: null, enumValues: null, inputFields: null },
  DateTime: { kind: 'SCALAR', name: 'DateTime', description: null, fields: null, enumValues: null, inputFields: null },
};

// ---------------------------------------------------------------------------
// resolved objects
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;

function userObj(login: string): AnyObj {
  return {
    __typename: 'User',
    id: login === VIEWER.login ? Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64') : Buffer.from(`User:0`, 'utf8').toString('base64'),
    login,
    name: login === VIEWER.login ? VIEWER.name : login,
    avatarUrl: '',
  };
}

function repoObj(repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: repo.id,
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObj(repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullObj(repo: Repo, pull: Pull): AnyObj {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    mergeable: pull.state === 'open' ? (pullConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
  };
}

function commentObj(repo: Repo, comment: { id: number; globalId: string; body: string; user: string; createdAt: string }): AnyObj {
  return {
    __typename: 'IssueComment',
    _repo: repo,
    _comment: comment,
    id: comment.globalId,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

/** Encode a page cursor over an item number. */
function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

/** Decode a page cursor back to its number, or null. */
function numberFromCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface PageArgs {
  first?: number;
  after?: string;
  states?: string[];
  orderBy?: { field?: string; direction?: string };
}

/**
 * A Relay-style connection over items that carry a `number`, ordered by number.
 * `direction` DESC is the default (newest first); ties break by number.
 */
function connection<T extends { number: number }>(
  typename: string,
  items: T[],
  toNode: (item: T) => AnyObj,
  args: PageArgs,
): AnyObj {
  let list = [...items];
  const direction = args.orderBy?.direction ?? 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = numberFromCursor(args.after);
  if (after !== null) {
    list = list.filter((item) => (direction === 'ASC' ? item.number > after : item.number < after));
  }
  const totalCount = list.length;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  return {
    __typename: typename,
    nodes: page.map(toNode),
    edges: page.map((item) => ({ __typename: `${typename.replace('Connection', 'Edge')}`, node: toNode(item), cursor: cursorFor(item.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------

type Resolver = (parent: AnyObj, args: Record<string, unknown>, store: Store) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(VIEWER.login),
    repository: (_parent, args, store) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : repoObj(repo);
    },
    node: (_parent, args, store) => {
      const id = String(args.id ?? '');
      const parts = Buffer.from(id, 'base64').toString('utf8').split(':');
      const kind = parts[0];
      if (kind === 'Repository') {
        const dbId = Number(parts[1]);
        for (const repo of store.repos.values()) if (repo.dbId === dbId) return repoObj(repo);
        return null;
      }
      if (kind === 'Issue') {
        const found = issueByGlobalId(store, id);
        return found === null ? null : issueObj(found.repo, found.issue);
      }
      if (kind === 'PullRequest') {
        const found = pullByGlobalId(store, id);
        return found === null ? null : pullObj(found.repo, found.pull);
      }
      if (kind === 'IssueComment') {
        const dbId = Number(parts[1]);
        const commentId = Number(parts[2]);
        for (const repo of store.repos.values()) {
          if (repo.dbId !== dbId) continue;
          for (const list of repo.comments.values()) {
            const comment = list.find((c) => c.id === commentId);
            if (comment !== undefined) return commentObj(repo, comment);
          }
        }
        return null;
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      const type = INTROSPECTION[name];
      if (type === undefined) return null;
      return {
        __typename: '__Type',
        kind: type.kind,
        name: type.name,
        description: type.description,
        fields: type.fields,
        enumValues: type.enumValues,
        inputFields: type.inputFields,
        interfaces: [],
        possibleTypes: [],
      };
    },
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', kind: 'OBJECT', name: 'Query' },
      mutationType: { __typename: '__Type', kind: 'OBJECT', name: 'Mutation' },
      subscriptionType: null,
      types: Object.values(INTROSPECTION).map((t) => ({ __typename: '__Type', kind: t.kind, name: t.name })),
    }),
  },
  Mutation: {
    createIssue: (_parent, args, store) => {
      const input = isRecord(args.input) ? args.input : {};
      const repositoryId = String(input.repositoryId ?? '');
      const parts = Buffer.from(repositoryId, 'base64').toString('utf8').split(':');
      if (parts[0] !== 'Repository') return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      const dbId = Number(parts[1]);
      let repo: Repo | undefined;
      for (const candidate of store.repos.values()) if (candidate.dbId === dbId) repo = candidate;
      if (repo === undefined) return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      const result = createIssue(repo, { title: input.title, body: input.body });
      if (!result.ok) return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, result.value), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_parent, args, store) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = issueByGlobalId(store, String(input.issueId ?? ''));
      if (found === null) return { __typename: 'CloseIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null };
      found.issue.state = 'closed';
      found.issue.jsonCache = undefined;
      return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_parent, args, store) => {
      const input = isRecord(args.input) ? args.input : {};
      const repositoryId = String(input.repositoryId ?? '');
      const parts = Buffer.from(repositoryId, 'base64').toString('utf8').split(':');
      if (parts[0] !== 'Repository') return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      const dbId = Number(parts[1]);
      let repo: Repo | undefined;
      for (const candidate of store.repos.values()) if (candidate.dbId === dbId) repo = candidate;
      if (repo === undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      const result = createPull(repo, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName });
      if (!result.ok) return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, result.value), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_parent, args, store) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = pullByGlobalId(store, String(input.pullRequestId ?? ''));
      if (found === null) return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null };
      mergePull(found.repo, found.pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_parent, args, store) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = issueByGlobalId(store, String(input.subjectId ?? ''));
      if (found === null) return { __typename: 'AddCommentPayload', commentEdge: null, clientMutationId: input.clientMutationId ?? null };
      const result = createComment(found.repo, found.issue.number, String(input.body ?? ''));
      if (!result.ok) return { __typename: 'AddCommentPayload', commentEdge: null, clientMutationId: input.clientMutationId ?? null };
      const node = commentObj(found.repo, result.value);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(result.value.id) },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  Repository: {
    owner: (parent) => userObj(String((parent._repo as Repo).owner)),
    defaultBranchRef: (parent) => ({ __typename: 'Ref', name: (parent._repo as Repo).defaultBranch, id: Buffer.from(`Ref:${(parent._repo as Repo).dbId}:main`, 'utf8').toString('base64') }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = parent._repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (parent, args) => {
      const repo = parent._repo as Repo;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let list = [...repo.issues.values()];
      if (states !== null) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      return connection('IssueConnection', list, (issue) => issueObj(repo, issue), {
        first: typeof args.first === 'number' ? args.first : undefined,
        after: typeof args.after === 'string' ? args.after : undefined,
        orderBy: isRecord(args.orderBy) ? { field: String(args.orderBy.field ?? ''), direction: String(args.orderBy.direction ?? '') } : undefined,
      });
    },
    pullRequest: (parent, args) => {
      const repo = parent._repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObj(repo, pull);
    },
    pullRequests: (parent, args) => {
      const repo = parent._repo as Repo;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let list = [...repo.pulls.values()];
      if (states !== null) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        list = list.filter((pull) => wanted.has(pullState(pull).toLowerCase()));
      }
      return connection('PullRequestConnection', list, (pull) => pullObj(repo, pull), {
        first: typeof args.first === 'number' ? args.first : undefined,
        after: typeof args.after === 'string' ? args.after : undefined,
        orderBy: isRecord(args.orderBy) ? { field: String(args.orderBy.field ?? ''), direction: String(args.orderBy.direction ?? '') } : undefined,
      });
    },
  },
  Issue: {
    author: (parent) => userObj(String((parent._issue as Issue).user)),
    labels: (parent, args) => {
      const issue = parent._issue as Issue;
      const nodes = issue.labels.map((label) => ({
        __typename: 'Label',
        id: Buffer.from(`Label:${label.name}`, 'utf8').toString('base64'),
        name: label.name,
        color: label.color,
      }));
      const first = typeof args.first === 'number' ? args.first : nodes.length;
      const page = nodes.slice(0, first);
      return {
        __typename: 'LabelConnection',
        nodes: page,
        pageInfo: { __typename: 'PageInfo', hasNextPage: nodes.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: nodes.length,
      };
    },
    comments: (parent, args) => {
      const repo = parent._repo as Repo;
      const issue = parent._issue as Issue;
      const list = (repo.comments.get(issue.number) ?? []).map((comment) => ({ ...comment, number: comment.id }));
      return connection('IssueCommentConnection', list, (comment) => commentObj(repo, comment), {
        first: typeof args.first === 'number' ? args.first : undefined,
        after: typeof args.after === 'string' ? args.after : undefined,
      });
    },
  },
  PullRequest: {
    author: (parent) => userObj(String((parent._pull as Pull).user)),
    headRef: (parent) => ({ __typename: 'Ref', name: (parent._pull as Pull).headRef, id: '' }),
    baseRef: (parent) => ({ __typename: 'Ref', name: (parent._pull as Pull).baseRef, id: '' }),
    files: (parent, args) => {
      const repo = parent._repo as Repo;
      const pull = parent._pull as Pull;
      const files = pullFiles(repo, pull);
      const nodes = files.map((file, index) => ({
        __typename: 'PullRequestFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status.toUpperCase(),
        number: index + 1,
      }));
      return connection('PullRequestFileConnection', nodes, (node) => node, {
        first: typeof args.first === 'number' ? args.first : undefined,
        after: typeof args.after === 'string' ? args.after : undefined,
      });
    },
    commits: (parent, args) => {
      const repo = parent._repo as Repo;
      const pull = parent._pull as Pull;
      const nodes = [{ __typename: 'PullRequestCommit', commit: { __typename: 'Commit', oid: pull.headSha, message: '' }, number: 1 }];
      void repo;
      const first = typeof args.first === 'number' ? args.first : nodes.length;
      const page = nodes.slice(0, first);
      return {
        __typename: 'PullRequestCommitConnection',
        nodes: page,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: nodes.length,
      };
    },
  },
  IssueComment: {
    author: (parent) => userObj(String((parent._comment as { user: string }).user)),
  },
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface ExecState {
  store: Store;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function fieldArgs(field: FieldNode, state: ExecState): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, state.variables);
  return args;
}

function resolveField(parent: AnyObj, parentType: string, field: FieldNode, state: ExecState): unknown {
  if (field.name === '__typename') return parentType;
  const byType = RESOLVERS[parentType];
  const resolver = byType?.[field.name];
  if (resolver !== undefined) return resolver(parent, fieldArgs(field, state), state.store);
  if (field.name in parent) return parent[field.name];
  state.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
  return undefined;
}

function completeValue(
  value: unknown,
  field: FieldNode,
  parentType: string,
  state: ExecState,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, field, parentType, state));
  }
  if (typeof value === 'object') {
    const obj = value as AnyObj;
    const typename = typeof obj.__typename === 'string' ? obj.__typename : parentType;
    if (field.selections.length === 0) return obj;
    return executeSelections(field.selections, obj, typename, state);
  }
  return value;
}

function executeSelections(
  selections: SelectionNode[],
  parent: AnyObj,
  parentType: string,
  state: ExecState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const value = resolveField(parent, parentType, selection, state);
      if (value === undefined) continue;
      const key = selection.alias ?? selection.name;
      out[key] = completeValue(value, selection, parentType, state);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment === undefined) {
        state.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(fragment.selections, parent, parentType, state));
      continue;
    }
    // Inline fragment.
    if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
    Object.assign(out, executeSelections(selection.selections, parent, parentType, state));
  }
  return out;
}

function executeOperation(
  doc: Document,
  operation: OperationNode,
  variables: Record<string, unknown>,
  store: Store,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const merged: Record<string, unknown> = { ...variables };
  for (const def of operation.variables) {
    if (!(def.name in merged) && def.defaultValue !== null) {
      merged[def.name] = resolveValue(def.defaultValue, merged);
    }
  }
  const state: ExecState = { store, fragments: doc.fragments, variables: merged, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(operation.selections, { __typename: rootType }, rootType, state);
  if (state.errors.length > 0) return { data, errors: state.errors };
  return { data };
}

/** Run one GraphQL request body (one document, or a batch) and return the result. */
export function executeGraphQL(
  body: unknown,
  store: Store,
): { status: number; result: unknown } {
  const runOne = (item: unknown): unknown => {
    if (!isRecord(item) || typeof item.query !== 'string') {
      return { errors: [{ message: 'A GraphQL document must carry a query string.' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(item.query).parseDocument();
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'GraphQL syntax error' }] };
    }
    const variables = isRecord(item.variables) ? (item.variables as Record<string, unknown>) : {};
    const operationName = typeof item.operationName === 'string' ? item.operationName : null;
    let operation: OperationNode | undefined;
    if (operationName !== null) operation = doc.operations.find((op) => op.name === operationName);
    else if (doc.operations.length === 1) operation = doc.operations[0];
    else operation = doc.operations[0];
    if (operation === undefined) return { errors: [{ message: 'No operation to run.' }] };
    return executeOperation(doc, operation, variables, store);
  };
  if (Array.isArray(body)) return { status: 200, result: body.map(runOne) };
  return { status: 200, result: runOne(body) };
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export function handleGraphQL(ctx: Ctx): boolean {
  if (ctx.segments.join('/') !== 'api/graphql') return false;
  if (ctx.method !== 'POST') {
    sendError(ctx, 405, 'Method Not Allowed');
    return true;
  }
  if (!requireAuth(ctx)) return true;
  if (ctx.jsonError || ctx.json === undefined) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const { status, result } = executeGraphQL(ctx.json, ctx.store);
  sendJson(ctx, status, result);
  return true;
}
