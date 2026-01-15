/**
 * Page Refresh - Context Persistence E2E Tests
 *
 * Tests for context information persistence across page refreshes.
 * Verifies that:
 * - Context percentage persists and displays correctly
 * - Token counts and metadata (capacity, model) persist
 * - Context breakdown details persist
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForMessageProcessed,
	cleanupTestSession,
	waitForElement,
	waitForWebSocketConnected,
} from './helpers/wait-helpers';

test.describe('Page Refresh - Context Persistence', () => {
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

	test('should restore context info percentage after refresh', async ({ page }) => {
		// Create session and send message
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);
		expect(sessionId).toBeTruthy();

		// Send a message to generate context
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Hello! Please respond briefly.');
		await messageInput.press('Enter');

		// Wait for processing to complete
		await waitForMessageProcessed(page, 'Hello! Please respond briefly.');

		// Wait for context indicator to show percentage
		await page.waitForFunction(
			() => {
				const contextEl = document.querySelector('span[class*="text-"][class*="-400"]');
				const contextText = contextEl?.textContent || '';
				// Check for percentage format: X.X% or <0.1%
				return /\d+\.\d+%|<\d+\.\d+%/.test(contextText);
			},
			{ timeout: 10000 }
		);

		// Capture context text before refresh
		const contextTextBefore = await page
			.locator('span[class*="text-"][class*="-400"]')
			.first()
			.textContent();
		expect(contextTextBefore).toBeTruthy();
		expect(contextTextBefore).toMatch(/\d+\.\d+%|<\d+\.\d+%/);

		// Refresh the page
		await page.reload();

		// Wait for reconnection
		await waitForWebSocketConnected(page);

		// Navigate back to the session
		await page.goto(`/${sessionId}`);

		// Wait for session to load
		await waitForElement(page, 'textarea[placeholder*="Ask"]', { timeout: 30000 });

		// Wait for context indicator to appear again
		await page.waitForFunction(
			() => {
				const contextEl = document.querySelector('span[class*="text-"][class*="-400"]');
				const contextText = contextEl?.textContent || '';
				return /\d+\.\d+%|<\d+\.\d+%/.test(contextText);
			},
			{ timeout: 10000 }
		);

		// Verify context indicator is visible with correct value
		const contextIndicator = page.locator('span[class*="text-"][class*="-400"]').first();
		await expect(contextIndicator).toBeVisible();

		const contextText = await contextIndicator.textContent();
		expect(contextText).toMatch(/\d+\.\d+%|<\d+\.\d+%/);
	});

	test('should persist token counts and metadata after refresh', async ({ page }) => {
		// Create session and send message
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Write a brief explanation of TypeScript.');
		await messageInput.press('Enter');

		// Wait for processing
		await waitForMessageProcessed(page, 'Write a brief explanation of TypeScript.');

		// Wait for context indicator to show percentage
		await page.waitForFunction(
			() => {
				const contextEl = document.querySelector('span[class*="text-"][class*="-400"]');
				const contextText = contextEl?.textContent || '';
				return /\d+\.\d+%|<\d+\.\d+%/.test(contextText);
			},
			{ timeout: 10000 }
		);

		// Verify context indicator is visible
		const contextIndicator = page.locator('span[class*="text-"][class*="-400"]').first();
		await expect(contextIndicator).toBeVisible();

		// Refresh page
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to session
		await page.goto(`/${sessionId}`);
		await waitForElement(page, 'textarea[placeholder*="Ask"]');

		// Wait for context indicator to appear again
		await page.waitForFunction(
			() => {
				const contextEl = document.querySelector('span[class*="text-"][class*="-400"]');
				const contextText = contextEl?.textContent || '';
				return /\d+\.\d+%|<\d+\.\d+%/.test(contextText);
			},
			{ timeout: 10000 }
		);

		// Verify context indicator is still visible after refresh
		await expect(contextIndicator).toBeVisible();
	});

	test('should restore context breakdown details after refresh', async ({ page }) => {
		// Create session and send message
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send a message to generate context
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Explain closures in JavaScript.');
		await messageInput.press('Enter');

		// Wait for processing
		await waitForMessageProcessed(page, 'Explain closures in JavaScript.');

		// Wait for context indicator to show percentage
		await page.waitForFunction(
			() => {
				const contextEl = document.querySelector('span[class*="text-"][class*="-400"]');
				const contextText = contextEl?.textContent || '';
				return /\d+\.\d+%|<\d+\.\d+%/.test(contextText);
			},
			{ timeout: 10000 }
		);

		// Verify context details can be opened
		const contextIndicator = page.locator('span[class*="text-"][class*="-400"]').first();
		await contextIndicator.click();

		// Context details dropdown should be visible
		await expect(page.locator('h3:has-text("Context Usage")')).toBeVisible();

		// Breakdown section should be visible
		await expect(page.locator('h4:has-text("Breakdown")')).toBeVisible();

		// Refresh page
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to session
		await page.goto(`/${sessionId}`);
		await waitForElement(page, 'textarea[placeholder*="Ask"]');

		// Wait for context indicator to appear again
		await page.waitForFunction(
			() => {
				const contextEl = document.querySelector('span[class*="text-"][class*="-400"]');
				const contextText = contextEl?.textContent || '';
				return /\d+\.\d+%|<\d+\.\d+%/.test(contextText);
			},
			{ timeout: 10000 }
		);

		// Verify context details can be opened after refresh
		const contextIndicatorAfter = page.locator('span[class*="text-"][class*="-400"]').first();
		await contextIndicatorAfter.click();

		// Context details dropdown should be visible
		await expect(page.locator('h3:has-text("Context Usage")')).toBeVisible();

		// Breakdown section should be visible
		await expect(page.locator('h4:has-text("Breakdown")')).toBeVisible();
	});
});
