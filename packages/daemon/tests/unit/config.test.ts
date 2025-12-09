/**
 * Config Tests
 *
 * Tests for the configuration module.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getConfig } from '../../src/config';

describe('getConfig', () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		// Store original environment
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		// Restore original environment
		process.env = originalEnv;
	});

	test('returns default values when no overrides or env vars', () => {
		// Clear relevant env vars
		delete process.env.PORT;
		delete process.env.HOST;
		delete process.env.DB_PATH;
		delete process.env.DEFAULT_MODEL;
		delete process.env.MAX_TOKENS;
		delete process.env.TEMPERATURE;
		delete process.env.MAX_SESSIONS;
		process.env.NODE_ENV = 'production';

		const config = getConfig();

		expect(config.port).toBe(9283);
		expect(config.host).toBe('0.0.0.0');
		expect(config.dbPath).toBe('./data/daemon.db');
		expect(config.defaultModel).toBe('claude-sonnet-4-5-20250929');
		expect(config.maxTokens).toBe(8192);
		expect(config.temperature).toBe(1.0);
		expect(config.maxSessions).toBe(10);
		expect(config.nodeEnv).toBe('production');
		// In production, workspaceRoot defaults to cwd
		expect(config.workspaceRoot).toBe(process.cwd());
	});

	test('uses environment variables when set', () => {
		process.env.PORT = '8080';
		process.env.HOST = '127.0.0.1';
		process.env.DB_PATH = '/custom/path/db.sqlite';
		process.env.DEFAULT_MODEL = 'claude-opus-4-20250514';
		process.env.MAX_TOKENS = '4096';
		process.env.TEMPERATURE = '0.5';
		process.env.MAX_SESSIONS = '20';
		process.env.NODE_ENV = 'production';

		const config = getConfig();

		expect(config.port).toBe(8080);
		expect(config.host).toBe('127.0.0.1');
		expect(config.dbPath).toBe('/custom/path/db.sqlite');
		expect(config.defaultModel).toBe('claude-opus-4-20250514');
		expect(config.maxTokens).toBe(4096);
		expect(config.temperature).toBe(0.5);
		expect(config.maxSessions).toBe(20);
	});

	test('CLI port override takes precedence over env var', () => {
		process.env.PORT = '8080';

		const config = getConfig({ port: 3000 });

		expect(config.port).toBe(3000);
	});

	test('CLI host override takes precedence over env var', () => {
		process.env.HOST = '127.0.0.1';

		const config = getConfig({ host: 'localhost' });

		expect(config.host).toBe('localhost');
	});

	test('CLI dbPath override takes precedence over env var', () => {
		process.env.DB_PATH = '/env/path/db.sqlite';

		const config = getConfig({ dbPath: '/cli/path/db.sqlite' });

		expect(config.dbPath).toBe('/cli/path/db.sqlite');
	});

	test('CLI workspace override takes precedence over env-based defaults', () => {
		process.env.NODE_ENV = 'production';

		const config = getConfig({ workspace: '/custom/workspace' });

		// This is the uncovered line 40 - workspace override
		expect(config.workspaceRoot).toBe('/custom/workspace');
	});

	test('uses project tmp/workspace in development mode', () => {
		process.env.NODE_ENV = 'development';

		const config = getConfig();

		// In development, should use project_root/tmp/workspace
		expect(config.workspaceRoot).toContain('tmp');
		expect(config.workspaceRoot).toContain('workspace');
	});

	test('uses cwd in production mode without workspace override', () => {
		process.env.NODE_ENV = 'production';

		const config = getConfig();

		expect(config.workspaceRoot).toBe(process.cwd());
	});

	test('reads API key from env var', () => {
		process.env.ANTHROPIC_API_KEY = 'sk-test-key';

		const config = getConfig();

		expect(config.anthropicApiKey).toBe('sk-test-key');
	});

	test('reads OAuth token from env var', () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-123';

		const config = getConfig();

		expect(config.claudeCodeOAuthToken).toBe('oauth-token-123');
	});
});
