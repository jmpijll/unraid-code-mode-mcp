/**
 * Tiny MCP stdio client for ad-hoc local verification.
 *
 *   node scripts/mcp-call.mjs <toolName> '<json args>'
 *
 * Spawns `node dist/index.js`, performs init, calls the tool, prints result.
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

let buf = '';
const responses = [];
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) {
      try { responses.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-call', version: '1' } } });
await new Promise((r) => setTimeout(r, 300));
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
await new Promise((r) => setTimeout(r, 200));
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: JSON.parse(argsJson) } });

await new Promise((r) => setTimeout(r, 4000));
child.stdin.end();
await new Promise((r) => child.on('exit', r));

const callResp = responses.find((r) => r.id === 2);
if (!callResp) {
  console.error('no tools/call response received; got:', responses.map((r) => r.id ?? r.method));
  process.exit(1);
}
const out = callResp.result ?? callResp.error;
console.log(JSON.stringify(out, null, 2));
