/**
 * Tiny MCP stdio client for ad-hoc local verification.
 *
 *   node scripts/mcp-call.mjs <toolName> '<json args>'
 *
 * Spawns `node dist/index.js`, performs init, calls the tool, prints result.
 *
 * Shutdown sequence (matters — careless EOF caused EPIPE crashes in earlier
 * versions):
 *   1. Send tools/call.
 *   2. Drain stdout until the response with id=2 arrives (or HARD_CAP_MS).
 *   3. Wait one extra tick so the server can flush any queued writes.
 *   4. Half-close stdin (`stdin.end()`) and let the server exit cleanly.
 *   5. Swallow EPIPE on stdin if the server has already gone away.
 */
import { spawn } from 'node:child_process';

const [, , toolName, argsJson = '{}'] = process.argv;
if (!toolName) {
  console.error('usage: node scripts/mcp-call.mjs <tool> <argsJson>');
  process.exit(2);
}

const child = spawn('node', ['dist/index.js'], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

// EPIPE on stdin is expected when the server has already closed its read side
// (e.g. on shutdown). We don't want that to crash the script.
child.stdin.on('error', (err) => {
  if (err && err.code === 'EPIPE') return;
  console.error('child stdin error:', err);
});
child.on('error', (err) => {
  console.error('child process error:', err);
});

let buf = '';
const responses = [];
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) {
      try {
        responses.push(JSON.parse(line));
      } catch {
        /* skip non-JSON */
      }
    }
  }
});

const send = (msg) => {
  if (child.stdin.writable) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }
};

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-call', version: '1' },
  },
});
await new Promise((r) => setTimeout(r, 300));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
await new Promise((r) => setTimeout(r, 200));
send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: toolName, arguments: JSON.parse(argsJson) },
});

// Wait for the call response (id=2) or hit a hard cap. The sandbox's own
// timeout caps server-side work; we just need to outlast that plus startup
// overhead. UNRAID_EXECUTE_TIMEOUT_MS (server-side, default 30s) gates how
// long the sandbox itself will run; the cap below should be at least
// (UNRAID_EXECUTE_TIMEOUT_MS + ~15s for startup + headroom).
const HARD_CAP_MS = Number(process.env.MCP_CALL_TIMEOUT_MS ?? 60_000);
const start = Date.now();
while (!responses.find((r) => r.id === 2) && Date.now() - start < HARD_CAP_MS) {
  await new Promise((r) => setTimeout(r, 100));
}

// Give the server a small grace window so any final writes flush before we
// half-close stdin (EOF). Without this the server can emit a queued write
// that races EPIPE.
await new Promise((r) => setTimeout(r, 50));
child.stdin.end();
// Wait for the server process to actually exit (or 5s, whichever is sooner)
// to keep the verification log tidy.
await Promise.race([
  new Promise((r) => child.on('exit', r)),
  new Promise((r) => setTimeout(r, 5_000)),
]);

const callResp = responses.find((r) => r.id === 2);
if (!callResp) {
  console.error(
    'no tools/call response received; got:',
    responses.map((r) => r.id ?? r.method),
  );
  process.exit(1);
}
const out = callResp.result ?? callResp.error;
console.log(JSON.stringify(out, null, 2));
