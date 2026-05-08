/**
 * MCP Server — Unraid Code Mode
 *
 * Registers two tools:
 *   - search   — query the GraphQL operation index via sandboxed JS (no network)
 *   - execute  — run Unraid GraphQL operations via sandboxed JS
 *
 * Each tool call resolves a TenantContext (env in single-user mode, headers
 * in multi-user mode), constructs a fresh ExecuteExecutor for that request,
 * runs the code, and returns formatted MCP tool content.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExecuteExecutor } from '../sandbox/execute-executor.js';
import { SearchExecutor } from '../sandbox/search-executor.js';
import { MAX_CODE_SIZE, MAX_RESULT_SIZE, type SandboxLimits } from '../sandbox/limits.js';
import type { ExecuteResult } from '../sandbox/types.js';
import type { ProcessedSpec } from '../types/spec.js';
import type { TenantContext } from '../tenant/context.js';

// ─── Tool descriptions ──────────────────────────────────────────────

const SEARCH_TOOL_DESCRIPTION = `Search the Unraid GraphQL schema by writing JavaScript.

The sandbox is read-only — no network. Use this tool to **discover** what to call before invoking \`execute\`.

## Globals

- \`index\` — \`{ namespace, title, version, sourceUrl, operations[], types }\`. Each operation is the compact form: \`{ kind: 'query'|'mutation', namespace: 'local', name, description, args, returnType, returnTypeFields, deprecated }\`.
- \`unraid.local\` — same shape as \`index\` for parity with the execute tool. May be \`null\` if no spec is loaded.
- \`searchOperations(query, limit?)\` — text-ranked search across name, description, args, and return type.
- \`getOperation(name)\` — full operation info including arg types and return-type field hints.
- \`findOperationsByName(substring)\` — list operations whose name contains the substring (case-insensitive).
- \`getType(typeName)\` — full named-type info (fields for OBJECT/INTERFACE/INPUT_OBJECT, members for UNION, enumValues for ENUM).
- \`console.log()\` — captured into the tool output.

## Examples

\`\`\`javascript
// All queries that mention "docker"
searchOperations('docker', 20).map(function (op) { return op.name; });
\`\`\`

\`\`\`javascript
// Full detail on the \`info\` query
getOperation('info');
\`\`\`

\`\`\`javascript
// Inspect the Array type to see its fields
getType('Array');
\`\`\`
`;

const EXECUTE_TOOL_DESCRIPTION = `Run Unraid GraphQL operations by writing JavaScript that uses the \`unraid.local\` namespace.

Although the sandbox is JavaScript, the calls below appear synchronous — \`await\` is supported and recommended. Each call returns once the host-side HTTP request settles.

Surfaces:

- \`unraid.local.graphql({ query, variables, operationName })\` — POST any GraphQL document directly to \`/graphql\`. Returns the unwrapped \`data\` field.
- \`unraid.local.query.<fieldName>({ args, fields })\` — typed query call. \`args\` map to GraphQL variables; \`fields\` is either a GraphQL selection-set string (no wrapping braces) or a shorthand array of leaf field names. \`fields\` is required for non-scalar return types.
- \`unraid.local.mutation.<fieldName>({ args, fields })\` — typed mutation call, same rules.
- \`unraid.local.request({ method, path, body, headers })\` — raw HTTP escape hatch for endpoints outside GraphQL. Returns \`{ status, body, headers }\`.
- \`unraid.local.spec\` — \`{ title, version, sourceUrl, queryCount, mutationCount }\` for diagnostics.

Operations are async — use \`await\`. The final expression is the tool result.

## Examples

\`\`\`javascript
// Read system info via a typed query.
const info = await unraid.local.query.info({
  fields: ['os { distro release kernel }', 'versions { unraid api }', 'cpu { manufacturer brand cores }'].join(' '),
});
return info;
\`\`\`

\`\`\`javascript
// List Docker containers with a shorthand selection.
const containers = await unraid.local.query.dockerContainers({
  fields: ['id', 'names', 'state', 'status', 'image'],
});
return containers.map(function (c) { return { name: c.names[0], state: c.state }; });
\`\`\`

\`\`\`javascript
// Raw GraphQL document — handy for fragments and aliases.
const data = await unraid.local.graphql({
  query: 'query { array { state capacity { kilobytes { free total } } } }',
});
return data;
\`\`\`

## Limits

- Hard ceiling on API calls per execute; exceeded → error.
- Sandbox memory + time bounded.
- Credentials never enter the sandbox.
`;

// ─── Server factory ─────────────────────────────────────────────────

export interface CreateServerOptions {
  /** Local Unraid spec, or undefined if not yet configured. */
  localSpec?: ProcessedSpec;
  /** Function called per request to obtain the TenantContext. */
  tenantResolver: () => TenantContext | Promise<TenantContext>;
  /** Sandbox limits override. */
  limits?: Partial<SandboxLimits>;
  /** Logger for tool-call audit trail. */
  logger?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
  };
  /** Server name + version for the MCP handshake. */
  name?: string;
  version?: string;
}

export function createMcpServer(options: CreateServerOptions): McpServer {
  const {
    localSpec,
    tenantResolver,
    limits,
    logger,
    name = 'unraid-code-mode-mcp',
    version = '0.1.0',
  } = options;

  const server = new McpServer(
    { name, version },
    {
      capabilities: { tools: {} },
      instructions: [
        'Unraid Code Mode MCP Server.',
        localSpec
          ? `unraid.local: ${localSpec.title} v${localSpec.version} — ${String(localSpec.queryCount)} queries, ${String(localSpec.mutationCount)} mutations`
          : 'unraid.local: NOT CONFIGURED',
        '',
        'Workflow: use `search` to find the operations you need, then call them via `execute`.',
      ].join('\n'),
    },
  );

  const searchExecutor = new SearchExecutor({ local: localSpec });

  server.registerTool(
    'search',
    {
      title: 'Search Unraid GraphQL schema',
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code to execute against the operation index. The final expression is returned.',
          ),
      },
    },
    async ({ code }) => {
      logger?.info(`[search] ${String(code.length)} chars`);
      if (code.length > MAX_CODE_SIZE) {
        return errorResult(
          `Code too large (${String(code.length)} chars, max ${String(MAX_CODE_SIZE)}).`,
        );
      }
      try {
        const result = await searchExecutor.execute(code);
        logger?.info(`[search] ${result.ok ? 'ok' : 'error'} ${String(result.durationMs)}ms`);
        return formatToolResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'execute',
    {
      title: 'Execute Unraid GraphQL operations',
      description: EXECUTE_TOOL_DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe(
            'JavaScript code to execute against the live Unraid GraphQL API. Use await — operations are async.',
          ),
      },
    },
    async ({ code }) => {
      logger?.info(`[execute] ${String(code.length)} chars`);
      if (code.length > MAX_CODE_SIZE) {
        return errorResult(
          `Code too large (${String(code.length)} chars, max ${String(MAX_CODE_SIZE)}).`,
        );
      }

      let tenant: TenantContext;
      try {
        tenant = await tenantResolver();
      } catch (err) {
        return errorResult(
          `Failed to resolve tenant credentials: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const executor = new ExecuteExecutor({
        tenant,
        ...(localSpec ? { localSpec } : {}),
        ...(limits ? { limits } : {}),
      });

      try {
        const result = await executor.execute(code);
        logger?.info(
          `[execute][${tenant.requestId}] ${result.ok ? 'ok' : 'error'} ${String(result.durationMs)}ms ${String(result.callsMade ?? 0)} calls`,
        );
        return formatToolResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

// ─── Result formatting ──────────────────────────────────────────────

function errorResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function formatToolResult(result: ExecuteResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  const parts: Array<{ type: 'text'; text: string }> = [];

  if (result.warnings.length > 0) {
    parts.push({
      type: 'text',
      text: `--- Warnings ---\n${result.warnings.map((w) => `[warn] ${w}`).join('\n')}`,
    });
  }

  if (result.logs.length > 0) {
    parts.push({
      type: 'text',
      text: `--- Console Output ---\n${result.logs.map((l) => `[${l.level}] ${l.message}`).join('\n')}`,
    });
  }

  if (result.ok) {
    let dataStr =
      result.data !== undefined
        ? typeof result.data === 'string'
          ? result.data
          : JSON.stringify(result.data, null, 2)
        : '(no return value)';
    if (dataStr.length > MAX_RESULT_SIZE) {
      const total = dataStr.length;
      dataStr =
        dataStr.slice(0, MAX_RESULT_SIZE) +
        `\n\n--- TRUNCATED (${String(total)} chars total, showing first ${String(MAX_RESULT_SIZE)}) ---` +
        '\nTip: filter, paginate, or select specific fields to reduce size.';
    }
    parts.push({ type: 'text', text: dataStr });
  } else {
    parts.push({ type: 'text', text: `Error: ${result.error ?? 'Unknown error'}` });
  }

  const meta = [`--- Executed in ${String(result.durationMs)}ms`];
  if (typeof result.callsMade === 'number' && result.callsMade > 0) {
    meta.push(`${String(result.callsMade)} API calls`);
  }
  parts.push({ type: 'text', text: `${meta.join(' · ')} ---` });

  return {
    content: parts,
    isError: !result.ok,
  };
}
