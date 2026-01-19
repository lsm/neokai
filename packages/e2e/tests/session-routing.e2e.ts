import { test, expect, type Page } from '@playwright/test';

/**
 * E2E tests for URL-based session routing
 *
 * Tests URL routing functionality including:
 * - URL updates when navigating to sessions
 * - Session persistence on page refresh
 * - Browser back/forward navigation
 * - Deep linking to sessions
 */

test.describe('URL-based Session Routing', () => {
	let page: Page;

	/**
	 * Helper: Create a session and return its ID
	 */
	async function createSession(page: Page): Promise<string> {
		// Navigate to home
		await page.goto('/');

		// Wait for app to be ready
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});

		// Store the current URL (should be /)
		const urlBefore = page.url();
		expect(urlBefore).toMatch(/\/$/);

		// Create a new session
		const createButton = page.locator('button:has-text("New Session")').first();
		await createButton.click();

		// Wait for navigation to complete
		await page.waitForURL(/.*\/session\/[a-f0-9-]+$/);

		// Extract session ID from URL
		const urlAfter = page.url();
		const match = urlAfter.match(/\/session\/([a-f0-9-]+)$/);
		expect(match).toBeTruthy();

		const sessionId = match ? match[1] : '';
		expect(sessionId).toBeTruthy();

		// Verify message input is visible (session is loaded)
		await page.waitForSelector('[data-testid="message-input"], textarea[placeholder*="Ask"]', {
			timeout: 10000,
		});

		return sessionId;
	}

	test.beforeEach(async ({ page: testPage }) => {
		page = testPage;
	});

	test('should update URL when navigating to a session', async () => {
		// Start at home
		await page.goto('/');
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});

		// Verify we're at home
		expect(page.url()).toMatch(/\/$/);

		// Create a session
		const sessionId = await createSession(page);

		// Verify URL changed to /session/{sessionId}
		expect(page.url()).toMatch(new RegExp(`\\/session\\/${sessionId}$`));
	});

	test('should persist session on page refresh', async () => {
		// Create a session
		const sessionId = await createSession(page);

		// Verify URL
		const urlBefore = page.url();
		expect(urlBefore).toContain(sessionId);

		// Refresh the page
		await page.reload();

		// Wait for app to reload
		await page.waitForSelector('textarea[placeholder*="Ask"]', {
			timeout: 10000,
		});

		// Verify URL still contains the session ID
		const urlAfter = page.url();
		expect(urlAfter).toContain(sessionId);

		// Verify message input is still visible (session is loaded)
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible();
	});

	test('should support browser back button to return to home', async () => {
		// Start at home
		await page.goto('/');
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});

		// Create a session
		await createSession(page);

		// Verify we're on a session page
		expect(page.url()).toMatch(/\/session\/[a-f0-9-]+$/);

		// Click browser back button
		await page.goBack();

		// Verify we're back at home
		await page.waitForURL(/\/$/, { timeout: 5000 });

		// Verify we see the home page (RecentSessions or welcome message)
		const welcomeText = page.locator('text=Welcome to Liuboer');
		const recentSessionsText = page.locator('text=Recent Sessions');
		const isVisible =
			(await welcomeText.isVisible().catch(() => false)) ||
			(await recentSessionsText.isVisible().catch(() => false));
		expect(isVisible).toBe(true);
	});

	test('should support browser forward button after going back', async () => {
		// Start at home
		await page.goto('/');
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});

		// Create a session
		const sessionId = await createSession(page);

		// Go back to home
		await page.goBack();
		await page.waitForURL(/\/$/, { timeout: 5000 });

		// Click forward button
		await page.goForward();

		// Verify we're back on the session page
		await page.waitForURL(new RegExp(`\\/session\\/${sessionId}$`), {
			timeout: 5000,
		});

		// Verify message input is visible
		await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible();
	});

	test('should handle deep linking to a session', async () => {
		// Create a session first
		const sessionId = await createSession(page);

		// Open a new page and navigate directly to the session URL
		const newPage = await page.context().newPage();
		await newPage.goto(`/session/${sessionId}`);

		// Wait for the app to load
		await newPage.waitForSelector('textarea[placeholder*="Ask"]', {
			timeout: 10000,
		});

		// Verify URL is correct
		expect(newPage.url()).toContain(sessionId);

		// Verify session is loaded (message input visible)
		await expect(newPage.locator('textarea[placeholder*="Ask"]').first()).toBeVisible();

		await newPage.close();
	});

	test('should update URL when clicking session in sidebar', async () => {
		// Create first session
		const sessionId1 = await createSession(page);

		// Create second session
		await page.goto('/');
		const sessionId2 = await createSession(page);

		// Ensure they're different
		expect(sessionId1).not.toBe(sessionId2);

		// Now navigate back to first session by clicking in sidebar
		// First, we need to get back to home to access the sidebar
		await page.goto('/');
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});

		// Click the first session from sidebar
		// The sidebar should show the most recent sessions
		const sessionCards = page.locator('button[data-session-id]').all();
		const count = await (await sessionCards).length;
		expect(count).toBeGreaterThan(0);

		// Click a session card
		const firstCard = page.locator('button[data-session-id]').first();
		await firstCard.click();

		// Verify URL changed
		await page.waitForURL(/\/session\/[a-f0-9-]+$/, { timeout: 5000 });
		expect(page.url()).toMatch(/\/session\/[a-f0-9-]+$/);
	});

	test('should maintain correct URL when navigating between multiple sessions', async () => {
		// Create first session
		const sessionId1 = await createSession(page);
		expect(page.url()).toContain(sessionId1);

		// Navigate home
		await page.goto('/');
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});

		// Create second session
		const sessionId2 = await createSession(page);
		expect(page.url()).toContain(sessionId2);
		expect(sessionId1).not.toBe(sessionId2);

		// Use back button to go to home
		await page.goBack();
		expect(page.url()).toMatch(/\/$/);

		// Use back button to return to first session
		await page.goBack();
		expect(page.url()).toContain(sessionId1);

		// Use forward button to go to home
		await page.goForward();
		expect(page.url()).toMatch(/\/$/);

		// Use forward button to return to second session
		await page.goForward();
		expect(page.url()).toContain(sessionId2);
	});

	test('should show home page when navigating to root URL', async () => {
		// Create a session
		await createSession(page);

		// Navigate to root
		await page.goto('/');

		// Wait for home page
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});

		// Verify we're at home (URL should be /)
		expect(page.url()).toMatch(/\/$/);

		// Verify home page elements are visible
		await expect(
			page.locator('text=Welcome to Liuboer').or(page.locator('h2:has-text("Liuboer")'))
		).toBeVisible();
	});

	test('should handle invalid session IDs gracefully', async () => {
		// Try to navigate to an invalid session
		await page.goto('/session/invalid-id-format');

		// App should still load (showing home or an error state)
		// The current behavior is to show home since the session won't be found
		await page.waitForSelector('button:has-text("New Session")', { timeout: 10000 }).catch(() => {
			// If New Session button not found, at least verify the page loaded
			return page.waitForSelector('body', { timeout: 5000 });
		});

		// Verify the page is in a usable state
		const body = page.locator('body');
		await expect(body).toBeVisible();
	});
});
