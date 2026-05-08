import { describe, expect, it } from 'vitest';
import {
  buildContextFromEnv,
  buildContextFromHeaders,
  HEADER_API_KEY,
  HEADER_BASE_URL,
  HEADER_CA_CERT,
  HEADER_INSECURE,
  MissingCredentialsError,
} from '../tenant/context.js';

describe('TenantContext', () => {
  describe('buildContextFromEnv', () => {
    it('returns empty context when no env creds set', () => {
      const ctx = buildContextFromEnv({});
      expect(ctx.local).toBeUndefined();
      expect(ctx.connect).toBeUndefined();
      expect(ctx.fromHeaders).toBe(false);
    });

    it('builds local creds from env', () => {
      const ctx = buildContextFromEnv({
        UNRAID_BASE_URL: 'https://tower.local/',
        UNRAID_API_KEY: 'k',
      });
      expect(ctx.local).toEqual({
        baseUrl: 'https://tower.local',
        apiKey: 'k',
        caCert: undefined,
        insecure: undefined,
      });
    });

    it('parses UNRAID_INSECURE booleans', () => {
      expect(
        buildContextFromEnv({
          UNRAID_BASE_URL: 'https://x',
          UNRAID_API_KEY: 'k',
          UNRAID_INSECURE: 'true',
        }).local?.insecure,
      ).toBe(true);
      expect(
        buildContextFromEnv({
          UNRAID_BASE_URL: 'https://x',
          UNRAID_API_KEY: 'k',
          UNRAID_INSECURE: 'no',
        }).local?.insecure,
      ).toBe(false);
    });

    it('omits local creds when only one of base/api-key is set', () => {
      expect(buildContextFromEnv({ UNRAID_BASE_URL: 'https://x' }).local).toBeUndefined();
      expect(buildContextFromEnv({ UNRAID_API_KEY: 'k' }).local).toBeUndefined();
    });
  });

  describe('buildContextFromHeaders', () => {
    it('reads creds from headers', () => {
      const ctx = buildContextFromHeaders(
        {
          [HEADER_API_KEY]: 'tk',
          [HEADER_BASE_URL]: 'https://controller/',
          [HEADER_INSECURE]: 'true',
          [HEADER_CA_CERT]: '-----BEGIN CERTIFICATE-----',
        },
        {},
      );
      expect(ctx.fromHeaders).toBe(true);
      expect(ctx.local).toEqual({
        baseUrl: 'https://controller',
        apiKey: 'tk',
        caCert: '-----BEGIN CERTIFICATE-----',
        insecure: true,
      });
    });

    it('throws when only one of api-key/base-url is supplied', () => {
      expect(() => buildContextFromHeaders({ [HEADER_API_KEY]: 'tk' }, {})).toThrow(
        MissingCredentialsError,
      );
      expect(() => buildContextFromHeaders({ [HEADER_BASE_URL]: 'https://x' }, {})).toThrow(
        MissingCredentialsError,
      );
    });

    it('falls back to env when headers absent', () => {
      const ctx = buildContextFromHeaders(
        {},
        { UNRAID_API_KEY: 'envk', UNRAID_BASE_URL: 'https://envhost' },
      );
      expect(ctx.local?.apiKey).toBe('envk');
      expect(ctx.local?.baseUrl).toBe('https://envhost');
    });

    it('treats array header values like the first value', () => {
      const ctx = buildContextFromHeaders(
        {
          [HEADER_API_KEY]: ['k1', 'k2'],
          [HEADER_BASE_URL]: 'https://x',
        },
        {},
      );
      expect(ctx.local?.apiKey).toBe('k1');
    });
  });

  describe('MissingCredentialsError', () => {
    it('produces actionable message for local', () => {
      const err = new MissingCredentialsError('local');
      expect(err.message).toContain('UNRAID_API_KEY');
      expect(err.message).toContain('X-Unraid-Api-Key');
    });
    it('mentions Connect reservation for connect namespace', () => {
      const err = new MissingCredentialsError('connect');
      expect(err.message).toContain('Connect');
    });
  });
});
