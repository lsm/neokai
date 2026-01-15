/**
 * Tablet Responsiveness E2E Tests
 *
 * Tests for tablet-specific responsive behavior:
 * - Sidebar display on tablet
 * - Session creation and usage on tablet
 */

import { test, expect } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

test.describe('Tablet Responsiveness', () => {
	let sessionId: string | null = null;

	// Use iPad viewport for tablet tests
	test.use({
		viewport: { width: 768, height: 1024 },
		hasTouch: true,
		isMobile: false,
	});

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

	test('should display sidebar on tablet', async ({ page }) => {
		// On tablet, check for sidebar controls
		// Sidebar is visible if "Close sidebar" button exists, or "Open menu" button for toggle
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		const openMenuButton = page.locator('button[aria-label="Open menu"]');
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });

		const hasCloseSidebar = await closeSidebarButton.isVisible().catch(() => false);
		const hasOpenMenu = await openMenuButton.isVisible().catch(() => false);
		const hasNewSession = await newSessionButton.isVisible().catch(() => false);

		// At least one navigation method should exist
		expect(hasCloseSidebar || hasOpenMenu || hasNewSession).toBe(true);
	});

	test('should create and use session on tablet', async ({ page }) => {
		// Create a session on tablet
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// On tablet, close sidebar if it's covering the chat area
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		if (await closeSidebarButton.isVisible().catch(() => false)) {
			await closeSidebarButton.click();
			await page.waitForTimeout(300);
		}

		// Send a message
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
		await textarea.fill('Hello from tablet');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
		});

		// Verify assistant message is displayed - this confirms layout works correctly
		const assistantMessage = page.locator('[data-message-role="assistant"]').first();
		await expect(assistantMessage).toBeVisible();
	});
});
