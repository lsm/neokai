/**
 * Credential Discovery Tests
 *
 * Tests the credential discovery module that enriches process.env
 * with Claude Code credentials at daemon startup.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { discoverCredentials } from '../../../src/lib/credential-discovery';

describe('discoverCredentials', () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		// Clear all auth-related env vars for clean test state
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.ANTHROPIC_BASE_URL;
		delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
		delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
		delete process.env.API_TIMEOUT_MS;
		delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('should return a valid DiscoveryResult', () => {
		const result = discoverCredentials();
		expect(result).toHaveProperty('credentialSource');
		expect(result).toHaveProperty('settingsEnvApplied');
		expect(result).toHaveProperty('errors');
		expect(Array.isArray(result.errors)).toBe(true);
		expect(typeof result.settingsEnvApplied).toBe('number');
	});

	it('should never throw', () => {
		// Even with no files and no env vars, should not throw
		expect(() => discoverCredentials()).not.toThrow();
	});

	it('should return "env" source when all credentials already present', () => {
		process.env.ANTHROPIC_API_KEY = 'sk-test';
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test';
		process.env.ANTHROPIC_AUTH_TOKEN = 'auth-test';

		const result = discoverCredentials();
		expect(result.credentialSource).toBe('env');
	});

	it('should not overwrite existing ANTHROPIC_API_KEY', () => {
		process.env.ANTHROPIC_API_KEY = 'my-explicit-key';

		discoverCredentials();

		// The explicit key should remain unchanged
		expect(process.env.ANTHROPIC_API_KEY).toBe('my-explicit-key');
	});

	it('should not overwrite existing CLAUDE_CODE_OAUTH_TOKEN', () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'my-explicit-token';

		discoverCredentials();

		expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('my-explicit-token');
	});

	it('should not overwrite existing ANTHROPIC_AUTH_TOKEN', () => {
		process.env.ANTHROPIC_AUTH_TOKEN = 'my-explicit-auth';

		discoverCredentials();

		expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('my-explicit-auth');
	});

	it('should have settingsEnvApplied >= 0', () => {
		const result = discoverCredentials();
		expect(result.settingsEnvApplied).toBeGreaterThanOrEqual(0);
	});

	it('should be idempotent for existing env vars', () => {
		process.env.ANTHROPIC_API_KEY = 'key-1';

		discoverCredentials();
		const keyAfterFirst = process.env.ANTHROPIC_API_KEY;

		discoverCredentials();
		const keyAfterSecond = process.env.ANTHROPIC_API_KEY;

		expect(keyAfterFirst).toBe('key-1');
		expect(keyAfterSecond).toBe('key-1');
	});
});
