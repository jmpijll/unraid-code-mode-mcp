import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('applies defaults when no env vars are set', () => {
    const cfg = loadConfig({});
    expect(cfg.mcpTransport).toBe('stdio');
    expect(cfg.mcpHttpPort).toBe(8000);
    expect(cfg.unraidMaxCallsPerExecute).toBe(50);
    expect(cfg.unraidExecuteTimeoutMs).toBe(30_000);
    expect(cfg.unraidBaseUrl).toBeUndefined();
    expect(cfg.unraidApiKey).toBeUndefined();
    expect(cfg.unraidInsecure).toBeUndefined();
  });

  it('parses UNRAID_EXECUTE_TIMEOUT_MS as an integer', () => {
    const cfg = loadConfig({ UNRAID_EXECUTE_TIMEOUT_MS: '60000' });
    expect(cfg.unraidExecuteTimeoutMs).toBe(60_000);
  });

  it('rejects UNRAID_EXECUTE_TIMEOUT_MS below 1000ms', () => {
    expect(() => loadConfig({ UNRAID_EXECUTE_TIMEOUT_MS: '500' })).toThrow(
      /unraidExecuteTimeoutMs/,
    );
  });

  it('rejects UNRAID_EXECUTE_TIMEOUT_MS above 600000ms (10 min cap)', () => {
    expect(() => loadConfig({ UNRAID_EXECUTE_TIMEOUT_MS: '600001' })).toThrow(
      /unraidExecuteTimeoutMs/,
    );
  });

  it('parses UNRAID_INSECURE as a boolean (true/1/yes)', () => {
    expect(loadConfig({ UNRAID_INSECURE: 'true' }).unraidInsecure).toBe(true);
    expect(loadConfig({ UNRAID_INSECURE: '1' }).unraidInsecure).toBe(true);
    expect(loadConfig({ UNRAID_INSECURE: 'yes' }).unraidInsecure).toBe(true);
    expect(loadConfig({ UNRAID_INSECURE: 'false' }).unraidInsecure).toBe(false);
    expect(loadConfig({ UNRAID_INSECURE: 'no' }).unraidInsecure).toBe(false);
  });

  it('splits MCP_HTTP_ALLOWED_ORIGINS on commas, trimming whitespace', () => {
    const cfg = loadConfig({
      MCP_HTTP_ALLOWED_ORIGINS: 'https://a.example,  https://b.example  ,  ',
    });
    expect(cfg.mcpHttpAllowedOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects invalid MCP_TRANSPORT values', () => {
    expect(() => loadConfig({ MCP_TRANSPORT: 'websocket' })).toThrow(/mcpTransport/);
  });

  it('rejects MCP_HTTP_PORT outside 1–65535', () => {
    expect(() => loadConfig({ MCP_HTTP_PORT: '0' })).toThrow(/mcpHttpPort/);
    expect(() => loadConfig({ MCP_HTTP_PORT: '70000' })).toThrow(/mcpHttpPort/);
  });
});
