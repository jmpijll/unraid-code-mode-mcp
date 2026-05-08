import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockHandler {
  match: (req: { query: string; variables?: unknown; operationName?: string }) => boolean;
  respond: (req: { query: string; variables?: unknown }) => unknown;
}

export interface MockServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

export interface StartMockServerOptions {
  handlers: MockHandler[];
}

/**
 * Start a tiny single-purpose GraphQL HTTP server. The server matches
 * requests against the supplied `handlers` and returns the first hit. If
 * no handler matches the request, a 404 with a helpful body is returned
 * so failing assertions surface clearly.
 */
export function startMockServer(opts: StartMockServerOptions): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.url !== '/graphql' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        let parsed: { query: string; variables?: unknown; operationName?: string };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad json' }));
          return;
        }
        const handler = opts.handlers.find((h) => h.match(parsed));
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'no handler matched',
              query: parsed.query,
            }),
          );
          return;
        }
        const reply = handler.respond(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${String(addr.port)}`,
        stop: () =>
          new Promise<void>((stopResolve, stopReject) => {
            server.close((err) => {
              if (err) stopReject(err);
              else stopResolve();
            });
          }),
      });
    });
  });
}
