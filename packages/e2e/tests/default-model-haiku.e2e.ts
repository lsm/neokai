import { test, expect } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * Default Model Configuration E2E Test
 *
 * Verifies that the DEFAULT_MODEL environment variable is correctly applied
 * to all new sessions created during E2E tests.
 *
 * Expected Behavior:
 * - When DEFAULT_MODEL=haiku is set, all new sessions should use Haiku model
 * - This ensures faster and cheaper test execution
 */
test.describe('Default Model Configuration', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Liuboer', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should create sessions with Haiku model when DEFAULT_MODEL=haiku', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		// Wait for session to be created
		sessionId = await waitForSessionCreated(page);
		expect(sessionId).toBeTruthy();

		// Get the session data via RPC to check the model
		const sessionData = await page.evaluate(async (sid) => {
			const messageHub = window.appState?.messageHub;
			if (!messageHub) {
				throw new Error('MessageHub not available');
			}

			try {
				const response = await messageHub.call('session.get', { sessionId: sid });
				return response;
			} catch (error) {
				console.error('Failed to get session:', error);
				throw error;
			}
		}, sessionId);

		// Verify the session was retrieved
		expect(sessionData).toBeTruthy();
		expect(sessionData.session).toBeTruthy();

		// Verify the model is set to Haiku
		const modelId = sessionData.session.config.model;
		expect(modelId).toBeTruthy();

		// The model should contain "haiku" in the ID (case-insensitive)
		// Valid examples: "claude-3-5-haiku-20241022", "haiku", etc.
		expect(modelId.toLowerCase()).toContain('haiku');

		console.log(`✅ Session ${sessionId} created with model: ${modelId}`);
	});

	test('should use Haiku model for all sessions in the test suite', async ({ page }) => {
		// Create multiple sessions to verify consistency
		const sessionIds: string[] = [];

		for (let i = 0; i < 3; i++) {
			// Navigate to home
			await page.goto('/');
			await page.waitForTimeout(500);

			// Create session
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();

			const sid = await waitForSessionCreated(page);
			sessionIds.push(sid);

			// Check model
			const sessionData = await page.evaluate(async (sessionIdToCheck) => {
				const messageHub = window.appState?.messageHub;
				const response = await messageHub.call('session.get', { sessionId: sessionIdToCheck });
				return response;
			}, sid);

			expect(sessionData.session.config.model.toLowerCase()).toContain('haiku');
		}

		// Cleanup all sessions
		for (const sid of sessionIds) {
			try {
				await cleanupTestSession(page, sid);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sid}:`, error);
			}
		}

		// Don't cleanup in afterEach since we already did it
		sessionId = null;

		console.log(`✅ All ${sessionIds.length} sessions created with Haiku model`);
	});

	test('should display Haiku model in session header', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Wait for the model info to be displayed in the UI
		// The model switcher dropdown should show the current model
		await page.waitForTimeout(2000);

		// Get the displayed model name from the model switcher
		const modelSwitcher = page.locator('[data-testid="model-switcher"]').first();

		// The switcher should be visible
		await expect(modelSwitcher).toBeVisible({ timeout: 5000 });

		// Get the text content which should contain "Haiku"
		const modelText = await modelSwitcher.textContent();

		// Verify it contains "Haiku" (case-insensitive)
		expect(modelText?.toLowerCase()).toContain('haiku');

		console.log(`✅ Model switcher displays: ${modelText}`);
	});
});
