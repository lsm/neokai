/**
 * Tablet Responsiveness E2E Tests
 *
 * Tests for tablet-specific responsive behavior:
 * - Sidebar display on tablet
 * - Session creation and usage on tablet
 */

import { test, expect } from '../../fixtures';
import {
	cleanupTestSession,
	createSessionViaUI,
	waitForAssistantResponse,
} from '../helpers/wait-helpers';
import { closeMobilePanel } from '../helpers/mobile-helpers';

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
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
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
		const closePanelButton = page.locator('button[title="Close panel"]');
		const menuButton = page.locator('button[aria-label="Open navigation menu"]');
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});

		const hasClosePanel = await closePanelButton.isVisible().catch(() => false);
		const hasMenuButton = await menuButton.isVisible().catch(() => false);
		const hasNewSession = await newSessionButton.isVisible().catch(() => false);

		// At least one navigation method should exist
		expect(hasClosePanel || hasMenuButton || hasNewSession).toBe(true);
	});

	test('should create and use session on tablet', async ({ page }) => {
		// Create a session on tablet
		sessionId = await createSessionViaUI(page);

		// On tablet, close panel if it's covering the chat area
		await closeMobilePanel(page);

		// Send a message
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
		await textarea.fill('Hello from tablet');
		await page.keyboard.press('Meta+Enter');

		// Wait for response using the shared helper (90s default for CI reliability)
		await waitForAssistantResponse(page);

		// Verify assistant message is displayed - this confirms layout works correctly
		const assistantMessage = page.locator('[data-message-role="assistant"]').first();
		await expect(assistantMessage).toBeVisible();
	});
});
