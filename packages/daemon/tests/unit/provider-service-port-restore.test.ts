/**
 * ProviderService.restoreEnvVars PORT restoration tests
 *
 * Tests that restoreEnvVars correctly handles the PORT key added to OriginalEnvVars
 * as part of the fix that clears PORT before SDK query to prevent the kill-chain bug.
 *
 * Covers:
 * - OriginalEnvVars interface includes the PORT field
 * - restoreEnvVars restores PORT when the original value was defined
 * - restoreEnvVars deletes PORT when the original value was undefined (never set)
 * - restoreEnvVars does nothing to PORT when the key is absent from the original object
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import type { OriginalEnvVars } from '../../src/lib/agent/query-runner';
import { ProviderService } from '../../src/lib/provider-service';

// Capture the original PORT value so tests can restore after themselves
const ORIGINAL_PORT = process.env.PORT;

describe('OriginalEnvVars interface — PORT field', () => {
	it('accepts PORT as an optional string field', () => {
		// Compile-time check: assigning PORT should be valid in the interface
		const vars: OriginalEnvVars = { PORT: '9283' };
		expect(vars.PORT).toBe('9283');
	});

	it('accepts PORT as undefined', () => {
		const vars: OriginalEnvVars = { PORT: undefined };
		expect(vars.PORT).toBeUndefined();
	});

	it('accepts an object with no PORT key', () => {
		const vars: OriginalEnvVars = {};
		expect(Object.prototype.hasOwnProperty.call(vars, 'PORT')).toBe(false);
	});
});

describe('ProviderService.restoreEnvVars — PORT restoration', () => {
	let service: ProviderService;

	beforeEach(() => {
		service = new ProviderService();
	});

	afterEach(() => {
		// Restore the real PORT to avoid polluting subsequent tests
		if (ORIGINAL_PORT !== undefined) {
			process.env.PORT = ORIGINAL_PORT;
		} else {
			delete process.env.PORT;
		}
	});

	it('restores PORT to the original value when original.PORT was defined', () => {
		// Simulate: daemon was started with PORT=9283, which was saved before clearing
		process.env.PORT = 'mutated-during-query'; // current (wrong) value

		const original: OriginalEnvVars = { PORT: '9283' };
		service.restoreEnvVars(original);

		expect(process.env.PORT).toBe('9283');
	});

	it('deletes PORT when original.PORT was explicitly undefined (port was not set before query)', () => {
		// Simulate: PORT was not in the environment before the query ran, so
		// query-runner saved undefined and deleted it; after restore it must be absent again.
		process.env.PORT = 'leaked-port'; // currently set due to some side-effect

		const original: OriginalEnvVars = { PORT: undefined };
		service.restoreEnvVars(original);

		expect(process.env.PORT).toBeUndefined();
	});

	it('does NOT touch PORT when the PORT key is absent from the original object', () => {
		// When PORT was never captured, restoreEnvVars must leave the current value alone
		process.env.PORT = 'should-be-untouched';

		const original: OriginalEnvVars = {}; // PORT key not present at all
		service.restoreEnvVars(original);

		expect(process.env.PORT).toBe('should-be-untouched');
	});

	it('handles an empty original object without throwing', () => {
		const original: OriginalEnvVars = {};
		expect(() => service.restoreEnvVars(original)).not.toThrow();
	});

	it('restores PORT alongside other keys in the same call', () => {
		process.env.PORT = 'wrong';
		process.env.ANTHROPIC_BASE_URL = 'http://proxy.example.com';

		const original: OriginalEnvVars = {
			PORT: '8080',
			ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
		};
		service.restoreEnvVars(original);

		expect(process.env.PORT).toBe('8080');
		expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');

		// Clean up ANTHROPIC_BASE_URL
		delete process.env.ANTHROPIC_BASE_URL;
	});
});
