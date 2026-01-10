import { test, expect } from '../fixtures';
import { cleanupTestSession } from './helpers/wait-helpers';

test.describe('Session Management', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		sessionId = null; // Reset for each test
	});

	test.afterEach(async ({ page }) => {
		// Cleanup any session created during the test
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should display sidebar with branding', async ({ page }) => {
		// Check for Liuboer branding in sidebar
		await expect(page.locator("h1:has-text('Liuboer')")).toBeVisible();
		await expect(page.locator(".text-2xl:has-text('🤖')")).toBeVisible();
	});

	test("should have a 'New Session' button", async ({ page }) => {
		const newSessionButton = page.locator("button:has-text('New Session')");
		await expect(newSessionButton).toBeVisible();
		await expect(newSessionButton).toBeEnabled();
	});

	test('should display connection status in footer', async ({ page }) => {
		// Check for connection status indicators in sidebar footer
		// The sidebar shows "Daemon" connection status and "Claude API" status
		await expect(page.locator('text=Daemon')).toBeVisible();
		await expect(page.locator('text=Connected').first()).toBeVisible();

		// Check for green indicator dot
		const statusDot = page.locator('.bg-green-500').first();
		await expect(statusDot).toBeVisible();
	});

	test("should create a new session when clicking 'New Session'", async ({ page }) => {
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		// Wait for session creation and navigation
		await page.waitForTimeout(1500);

		// Verify we're in a session (message input should be visible)
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 5000 });

		// Get the session ID from the URL for cleanup
		sessionId = await page.evaluate(() => {
			const pathId = window.location.pathname.split('/').filter(Boolean)[0];
			return pathId && pathId !== 'undefined' ? pathId : null;
		});

		// Note: Session will be cleaned up in afterEach
	});
});
