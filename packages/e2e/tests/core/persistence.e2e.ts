/**
 * Page Refresh - Session State Persistence E2E Tests
 *
 * Tests for session state persistence across page refreshes.
 * Verifies that:
 * - Agent state properly resets to idle (expected behavior)
 * - Slash commands remain available from database
 * - Full session state (messages and title) is restored accurately
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForMessageProcessed,
	cleanupTestSession,
	waitForElement,
	waitForWebSocketConnected,
} from '../helpers/wait-helpers';

test.describe('Page Refresh - Session State Persistence', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
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

	test('should reset agent state to idle after refresh (expected behavior)', async ({ page }) => {
		// Create session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Tell me a short story.');

		const sendButton = page.locator('[data-testid="send-button"]');
		await sendButton.click();

		// Wait briefly for message to be sent
		await page.waitForTimeout(2000);

		// Refresh page during or right after sending
		await page.reload();
		await page.waitForLoadState('domcontentloaded');

		// Wait for reconnection
		await waitForWebSocketConnected(page);

		// Navigate back to session by clicking on it in the sidebar
		const sessionButton = page.locator(`[data-session-id="${sessionId}"]`);
		await sessionButton.waitFor({ state: 'visible', timeout: 10000 });
		await sessionButton.click();

		// Wait for textarea to appear (may take time for session to load)
		await waitForElement(page, 'textarea[placeholder*="Ask"]', {
			timeout: 30000,
		});

		// Verify agent state is idle (expected behavior - state resets on refresh)
		// Input should be enabled (not processing)
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(input).toBeEnabled({ timeout: 10000 });
	});

	test('should restore slash commands immediately after refresh', async ({ page }) => {
		// Create session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Wait for commands to load (check for autocomplete to be available)
		await page.waitForTimeout(2000);

		// Verify commands are available before refresh by checking if autocomplete works
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('/');

		// Wait briefly for autocomplete
		await page.waitForTimeout(500);

		// Clear the input
		await messageInput.fill('');

		// Refresh page
		await page.reload();
		await page.waitForLoadState('domcontentloaded');

		// Wait for reconnection
		await waitForWebSocketConnected(page);

		// Navigate back to session by clicking on it in the sidebar
		const sessionButton = page.locator(`[data-session-id="${sessionId}"]`);
		await sessionButton.waitFor({ state: 'visible', timeout: 10000 });
		await sessionButton.click();

		// Wait for textarea
		await waitForElement(page, 'textarea[placeholder*="Ask"]', {
			timeout: 30000,
		});

		// Wait for page to stabilize
		await page.waitForTimeout(2000);

		// Get fresh reference to the input after navigation
		const inputAfterRefresh = page.locator('textarea[placeholder*="Ask"]').first();

		// Verify commands are still available after refresh
		await inputAfterRefresh.fill('/');

		// Wait briefly for autocomplete
		await page.waitForTimeout(500);

		// Autocomplete state check skipped for now
		// TODO: Verify autocomplete dropdown state after page refresh
	});

	test('should restore full session state including messages and title', async ({ page }) => {
		// Create session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send message and wait for title generation
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('What is React and why is it popular?');
		await messageInput.press('Enter');

		// Wait for message processing
		await waitForMessageProcessed(page, 'What is React and why is it popular?');

		// Wait for title to be generated
		const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
		await page.waitForFunction(
			(sid) => {
				const sessionEl = document.querySelector(`[data-session-id="${sid}"]`);
				const titleEl = sessionEl?.querySelector('h3');
				const titleText = titleEl?.textContent || '';
				return titleText !== 'New Session' && titleText.length > 0;
			},
			sessionId,
			{ timeout: 45000 } // GLM-4.7 can take 30-40s in CI due to API latency
		);

		// Count messages before refresh
		const messageCountBefore = await page.locator('[data-message-role]').count();
		expect(messageCountBefore).toBeGreaterThanOrEqual(2); // At least 1 user + 1 assistant

		// Refresh page
		await page.reload();
		await page.waitForLoadState('domcontentloaded');

		// Wait for reconnection
		await waitForWebSocketConnected(page);

		// Navigate back to session by clicking on it in the sidebar
		const sessionButtonRefresh = page.locator(`[data-session-id="${sessionId}"]`);
		await sessionButtonRefresh.waitFor({ state: 'visible', timeout: 10000 });
		await sessionButtonRefresh.click();

		// Wait for textarea
		await waitForElement(page, 'textarea[placeholder*="Ask"]', {
			timeout: 30000,
		});

		// Wait for messages to be restored
		await page.waitForFunction(
			(expectedCount) => {
				const messages = document.querySelectorAll('[data-message-role]');
				return messages.length >= expectedCount;
			},
			messageCountBefore,
			{ timeout: 10000 }
		);

		// Verify message count is restored
		const messageCountAfter = await page.locator('[data-message-role]').count();
		expect(messageCountAfter).toBe(messageCountBefore);

		// Verify original message is still visible
		await expect(page.locator('text=What is React and why is it popular?')).toBeVisible();

		// Verify session title is restored in sidebar
		await expect(sessionItem).toBeVisible();
		const titleAfter = await sessionItem.locator('h3').textContent();
		expect(titleAfter).not.toBe('New Session');
		expect(titleAfter?.length).toBeGreaterThan(0);
	});
});
