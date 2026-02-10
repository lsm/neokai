/**
 * Global Settings Applied to New Sessions - E2E Tests
 *
 * Verifies that global settings (model, thinking, autoScroll) are applied
 * when creating new sessions, and that when settings change, new sessions
 * reflect the updated values.
 *
 * Bug: Global settings for model, thinking, and autoScroll were not being
 * applied to new sessions correctly.
 *
 * IMPORTANT: These tests MUST run serially because they modify shared global settings.
 * Parallel execution would cause race conditions where one test's cleanup
 * overwrites another test's settings mid-execution.
 */

import { test, expect, type Page } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

/**
 * Helper: Update global settings via RPC (partial update)
 */
async function updateGlobalSettings(page: Page, updates: Record<string, unknown>): Promise<void> {
	const result = await page.evaluate(async (settingsUpdates) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub || !hub.request) throw new Error('MessageHub not available');
		return await hub.request(
			'settings.global.update',
			{ updates: settingsUpdates },
			{ timeout: 5000 }
		);
	}, updates);
	// Verify the update succeeded
	expect(result).toHaveProperty('success', true);
}

/**
 * Helper: Get global settings via RPC
 */
async function getGlobalSettings(page: Page): Promise<Record<string, unknown>> {
	return await page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub || !hub.request) throw new Error('MessageHub not available');
		return (await hub.request('settings.global.get', {}, { timeout: 5000 })) as Record<
			string,
			unknown
		>;
	});
}

/**
 * Helper: Save global settings via RPC (full replace)
 */
async function saveGlobalSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
	await page.evaluate(async (s) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub || !hub.request) throw new Error('MessageHub not available');
		await hub.request('settings.global.save', { settings: s }, { timeout: 5000 });
	}, settings);
}

/**
 * Helper: Get session config via RPC
 */
async function getSessionConfig(page: Page, sessionId: string): Promise<Record<string, unknown>> {
	return await page.evaluate(async (sid) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub || !hub.request) throw new Error('MessageHub not available');
		const result = (await hub.request('session.get', { sessionId: sid }, { timeout: 5000 })) as {
			session?: { config?: Record<string, unknown> };
		};
		return result?.session?.config || {};
	}, sessionId);
}

/**
 * Helper: Create session via RPC (bypasses UI to isolate the settings application logic)
 */
async function createSessionViaRPC(page: Page): Promise<string> {
	return await page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub || !hub.request) throw new Error('MessageHub not available');
		const result = (await hub.request(
			'session.create',
			{ workspacePath: undefined },
			{ timeout: 15000 }
		)) as {
			sessionId: string;
		};
		return result.sessionId;
	});
}

/**
 * Helper: Delete session via RPC
 */
async function deleteSessionViaRPC(page: Page, sessionId: string): Promise<void> {
	await page.evaluate(async (sid) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub || !hub.request) return;
		try {
			await hub.request('session.delete', { sessionId: sid }, { timeout: 10000 });
		} catch {
			// Ignore cleanup errors
		}
	}, sessionId);
}

/**
 * Helper: Get available models and find test models
 */
async function getTestModels(page: Page): Promise<{ defaultModel?: string; testModel?: string }> {
	const models = await page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub || !hub.request) throw new Error('MessageHub not available');
		const result = (await hub.request('models.list', { useCache: true }, { timeout: 10000 })) as {
			models: Array<{ id: string; display_name: string }>;
		};
		return result.models || [];
	});

	const defaultModel = models.find((m) => m.id.includes('haiku'))?.id;
	const testModel =
		models.find((m) => m.id.includes('opus'))?.id ||
		models.find((m) => m.id.includes('sonnet') && !m.id.includes('haiku'))?.id;

	return { defaultModel, testModel };
}

// SERIAL execution is required - tests modify shared global settings
test.describe
	.serial('Global Settings Applied to New Sessions', () => {
		// Track sessions created during tests for cleanup
		const createdSessionIds: string[] = [];
		// Store original settings to restore after tests
		let originalSettings: Record<string, unknown> | null = null;

		test.beforeEach(async ({ page }) => {
			await page.goto('/');
			await waitForWebSocketConnected(page);

			// Save original settings for restoration (only on first test)
			if (!originalSettings) {
				originalSettings = await getGlobalSettings(page);
			}
		});

		test.afterEach(async ({ page }) => {
			// Clean up created sessions
			for (const sessionId of createdSessionIds) {
				await deleteSessionViaRPC(page, sessionId);
			}
			createdSessionIds.length = 0;

			// Restore original settings after each test
			if (originalSettings) {
				try {
					await saveGlobalSettings(page, originalSettings);
				} catch {
					// Ignore restore errors
				}
			}
		});

		test('first session uses current global settings for model, thinking, and autoScroll', async ({
			page,
		}) => {
			// Get available models to use for testing
			const { testModel } = await getTestModels(page);

			if (!testModel) {
				test.skip();
				return;
			}

			// Set global settings to specific test values
			await updateGlobalSettings(page, {
				model: testModel,
				thinkingLevel: 'medium',
				autoScroll: false,
			});

			// Verify the settings were saved
			const settingsAfterUpdate = await getGlobalSettings(page);
			expect(settingsAfterUpdate).toHaveProperty('model', testModel);
			expect(settingsAfterUpdate).toHaveProperty('thinkingLevel', 'medium');
			expect(settingsAfterUpdate).toHaveProperty('autoScroll', false);

			// Create a new session
			const sessionId = await createSessionViaRPC(page);
			createdSessionIds.push(sessionId);

			// Verify the session config matches the global settings
			const sessionConfig = await getSessionConfig(page, sessionId);
			expect(sessionConfig.model).toBe(testModel);
			expect(sessionConfig.thinkingLevel).toBe('medium');
			expect(sessionConfig.autoScroll).toBe(false);
		});

		test('after updating global settings, new session uses updated values for model, thinking, and autoScroll', async ({
			page,
		}) => {
			// Get available models to use for testing
			const { testModel } = await getTestModels(page);

			if (!testModel) {
				test.skip();
				return;
			}

			// First, set global settings to initial values
			await updateGlobalSettings(page, {
				model: testModel,
				thinkingLevel: 'low',
				autoScroll: false,
			});

			// Create a session with the initial settings
			const firstSessionId = await createSessionViaRPC(page);
			createdSessionIds.push(firstSessionId);

			// Verify first session has the initial settings
			const firstSessionConfig = await getSessionConfig(page, firstSessionId);
			expect(firstSessionConfig.model).toBe(testModel);
			expect(firstSessionConfig.thinkingLevel).toBe('low');
			expect(firstSessionConfig.autoScroll).toBe(false);

			// Now update global settings to NEW values
			// Use a different model if available, or same model with different settings
			const models = await page.evaluate(async () => {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub || !hub.request) throw new Error('MessageHub not available');
				const result = (await hub.request(
					'models.list',
					{ useCache: true },
					{ timeout: 10000 }
				)) as {
					models: Array<{ id: string; display_name: string }>;
				};
				return result.models || [];
			});

			// Find a different model if available, otherwise use the same model
			const newModel =
				models.find((m) => m.id !== testModel && (m.id.includes('sonnet') || m.id.includes('opus')))
					?.id || testModel;

			await updateGlobalSettings(page, {
				model: newModel,
				thinkingLevel: 'high',
				autoScroll: true,
			});

			// Verify the settings were updated
			const settingsAfterUpdate = await getGlobalSettings(page);
			expect(settingsAfterUpdate).toHaveProperty('model', newModel);
			expect(settingsAfterUpdate).toHaveProperty('thinkingLevel', 'high');
			expect(settingsAfterUpdate).toHaveProperty('autoScroll', true);

			// Create another session with the UPDATED settings
			const secondSessionId = await createSessionViaRPC(page);
			createdSessionIds.push(secondSessionId);

			// Verify the NEW session has the UPDATED settings
			const secondSessionConfig = await getSessionConfig(page, secondSessionId);
			expect(secondSessionConfig.model).toBe(newModel);
			expect(secondSessionConfig.thinkingLevel).toBe('high');
			expect(secondSessionConfig.autoScroll).toBe(true);

			// Verify the FIRST session still has its original settings (not affected by settings change)
			const firstSessionConfigAfter = await getSessionConfig(page, firstSessionId);
			expect(firstSessionConfigAfter.model).toBe(testModel);
			expect(firstSessionConfigAfter.thinkingLevel).toBe('low');
			expect(firstSessionConfigAfter.autoScroll).toBe(false);
		});

		test('new session uses default values when global settings are not explicitly set', async ({
			page,
		}) => {
			// Get current settings and remove model, thinkingLevel, autoScroll
			const settings = await getGlobalSettings(page);
			const {
				model: _,
				thinkingLevel: __,
				autoScroll: ___,
				...settingsWithoutDefaults
			} = settings as Record<string, unknown>;

			// Save settings without explicit model, thinkingLevel, autoScroll values
			await saveGlobalSettings(page, settingsWithoutDefaults);

			// Create a new session
			const sessionId = await createSessionViaRPC(page);
			createdSessionIds.push(sessionId);

			// Verify the session has expected defaults
			const sessionConfig = await getSessionConfig(page, sessionId);
			// autoScroll should default to true (from DEFAULT_GLOBAL_SETTINGS)
			expect(sessionConfig.autoScroll).toBe(true);
			// model and thinkingLevel may be undefined or have their own defaults
			// (these are optional and the application/SDK handles defaults)
		});
	});
