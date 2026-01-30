import { test, expect } from '../fixtures';
import {
	cleanupTestSession,
	waitForSessionCreated,
	waitForAssistantResponse,
} from './helpers/wait-helpers';

/**
 * Context Dropdown E2E Tests
 *
 * Tests the context usage dropdown in the ContextUsageBar component
 * (part of SessionStatusBar).
 * - Context percentage display
 * - Dropdown visibility on click
 * - Context category breakdown
 */
test.describe('Context Dropdown', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'NeoKai', exact: true }).first()).toBeVisible();
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

	test('should display context percentage after message exchange', async ({ page }) => {
		// Create a new session - use specific selector for the primary New Session button
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message - use placeholder that matches actual input field
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Hello, what is 2+2?');
		await page.keyboard.press('Meta+Enter'); // Cmd+Enter on Mac

		// Wait for response to complete (look for the assistant message)
		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
		});

		// Context percentage should be visible
		const contextPercentage = page.locator('.text-xs.font-medium:has-text("%")').first();
		await expect(contextPercentage).toBeVisible();
	});

	test('should open dropdown on context percentage click', async ({ page }) => {
		// Create a new session - use specific selector for the primary New Session button
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message - use placeholder that matches actual input field
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Hello, what is 2+2?');
		await page.keyboard.press('Meta+Enter');

		// Wait for assistant response using helper
		await waitForAssistantResponse(page);

		// Wait for context data to be loaded (title changes from "loading" to "click for details")
		const contextIndicator = page.locator('[title="Click for context details"]');
		await expect(contextIndicator).toBeVisible({ timeout: 15000 });

		// Click on context percentage to open dropdown
		await contextIndicator.click();

		// Dropdown should appear with "Context Usage" header
		await expect(page.getByText('Context Usage', { exact: true })).toBeVisible({
			timeout: 3000,
		});
	});

	test('should show context category breakdown in dropdown', async ({ page }) => {
		// Create a new session - use specific selector for the primary New Session button
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a test message - use placeholder that matches actual input field
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Hello, what is 2+2?');
		await page.keyboard.press('Meta+Enter');

		// Wait for assistant response using helper
		await waitForAssistantResponse(page);

		// Wait for context data to be loaded
		const contextIndicator = page.locator('[title="Click for context details"]');
		await expect(contextIndicator).toBeVisible({ timeout: 15000 });

		// Click on context percentage to open dropdown
		await contextIndicator.click();

		// First verify the "Context Usage" header appears (dropdown is open)
		await expect(page.getByText('Context Usage', { exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Then verify the breakdown section appears
		await expect(page.getByText('Breakdown', { exact: true })).toBeVisible({
			timeout: 3000,
		});

		// Verify context breakdown items are displayed by checking for percentage signs in the breakdown
		// The breakdown should have at least 3 categories: Input Context, Output Tokens, Free Space
		// Each shows a percentage like "0.0%" or "100.0%"
		const dropdownContent = page
			.locator('.bg-dark-800.border.rounded-lg')
			.filter({ hasText: 'Context Usage' });
		const percentageCount = await dropdownContent.getByText(/\d+\.\d+%/, { exact: false }).count();
		expect(percentageCount).toBeGreaterThanOrEqual(3); // At least 3 categories with percentages

		// Also verify we see the expected context capacity text
		await expect(dropdownContent.getByText(/200,000/)).toBeVisible();

		// Take screenshot for visual verification
		await page.screenshot({
			path: 'test-results/context-dropdown.png',
			fullPage: true,
		});
	});
});
