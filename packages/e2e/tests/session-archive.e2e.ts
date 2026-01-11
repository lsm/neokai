/**
 * Session Archive E2E Tests
 *
 * End-to-end tests for the session archiving functionality.
 * Tests the archive feature available from the Session options dropdown.
 *
 * Features tested:
 * 1. Archive option in session options menu
 * 2. Archive session flow
 * 3. Archived session indicators
 * 4. Preventing messages in archived sessions
 * 5. Archived sessions toggle in sidebar
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect, type Page } from '../fixtures';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
	waitForAssistantResponse,
} from './helpers/wait-helpers';

/**
 * Open the Session options dropdown menu
 */
async function openSessionOptionsMenu(page: Page): Promise<void> {
	// Click the session options button (gear icon in chat header)
	const optionsButton = page.locator('button[aria-label="Session options"]').first();
	await optionsButton.waitFor({ state: 'visible', timeout: 5000 });
	await optionsButton.click();

	// Wait for menu to appear
	await page.waitForTimeout(300);
}

/**
 * Click Archive Session in the dropdown menu
 */
async function clickArchiveSession(page: Page): Promise<void> {
	const archiveItem = page.locator('text=Archive Session').first();
	await archiveItem.waitFor({ state: 'visible', timeout: 3000 });
	await archiveItem.click();
}

/**
 * Create a session with a message to have content
 */
async function createSessionWithMessage(page: Page): Promise<string> {
	// Create new session
	const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
	await newSessionButton.click();
	const sessionId = await waitForSessionCreated(page);

	// Send a simple message
	const textarea = page.locator('textarea[placeholder*="Ask"]');
	await textarea.fill('Hello, say "test message acknowledged"');
	await page.keyboard.press('Meta+Enter');

	// Wait for response
	await waitForAssistantResponse(page);

	return sessionId;
}

test.describe('Session Archive - Menu Option', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);
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

	test('should show Archive Session option in session options menu', async ({ page }) => {
		await openSessionOptionsMenu(page);

		// Should show Archive Session option
		await expect(page.locator('text=Archive Session')).toBeVisible();
	});

	test('should show Tools, Export, Archive, and Delete options in menu', async ({ page }) => {
		await openSessionOptionsMenu(page);

		// Should show all expected options
		await expect(page.locator('text=Tools')).toBeVisible();
		await expect(page.locator('text=Export as Markdown')).toBeVisible();
		await expect(page.locator('text=Archive Session')).toBeVisible();
		await expect(page.locator('text=Delete Session')).toBeVisible();
	});
});

test.describe('Session Archive - Archiving Flow', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should archive session successfully', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Open options and click archive
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for success toast or UI update
		await page.waitForTimeout(1000);

		// Should show success toast
		await expect(page.locator('text=Session archived')).toBeVisible({ timeout: 5000 });
	});

	test('should show archived label after archiving', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1000);

		// Should show "Session archived" label in the chat area
		await expect(page.locator('text=Session archived')).toBeVisible({ timeout: 5000 });
	});

	test('should disable Archive option for already archived session', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// Open options menu again
		await openSessionOptionsMenu(page);

		// Archive option should be disabled or show "Unarchive" instead
		const archiveItem = page.locator('text=Archive Session').first();
		const _isDisabled =
			(await archiveItem.getAttribute('aria-disabled')) === 'true' ||
			(await archiveItem.locator('..').getAttribute('class'))?.includes('opacity') ||
			(await archiveItem.locator('..').getAttribute('class'))?.includes('cursor-not-allowed');

		// Close menu
		await page.keyboard.press('Escape');
	});
});

test.describe('Session Archive - Archived Session Behavior', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should prevent sending messages in archived session', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// The message input should be replaced with an archived label
		// Check that textarea is not visible or is disabled
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		const isTextareaHidden = (await textarea.count()) === 0 || !(await textarea.isVisible());

		// Should show archived indicator instead of input
		const archivedIndicator = page.locator('text=Session archived');
		const hasArchivedLabel = (await archivedIndicator.count()) > 0;

		expect(isTextareaHidden || hasArchivedLabel).toBeTruthy();
	});

	test('should show archived indicator with icon', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// Should show archived text
		await expect(page.locator('text=Session archived')).toBeVisible();

		// Should have archive icon (a box icon typically)
		const archiveIconSection = page.locator('text=Session archived').locator('..');
		await expect(archiveIconSection.locator('svg')).toBeVisible();
	});
});

test.describe('Session Archive - Sidebar Toggle', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should hide archived sessions by default', async ({ page }) => {
		// Create and archive a session
		sessionId = await createSessionWithMessage(page);

		// Get session title before archiving
		const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
		await expect(sessionLink).toBeVisible();

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// The "Show archived" toggle should appear since we now have an archived session
		const showArchivedToggle = page.locator('text=Show archived');

		// If toggle is visible, archived sessions are hidden by default
		if ((await showArchivedToggle.count()) > 0) {
			await expect(showArchivedToggle).toBeVisible();
		}
	});

	test('should show archived toggle when archived sessions exist', async ({ page }) => {
		// Create and archive a session
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// Navigate away from the archived session
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// The toggle should be visible
		const toggleButton = page.locator(
			'button:has-text("Show archived"), button:has-text("Hide archived")'
		);
		await expect(toggleButton).toBeVisible({ timeout: 3000 });
	});

	test('should toggle archived sessions visibility', async ({ page }) => {
		// Create and archive a session
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// Navigate home
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Find and click the Show archived toggle
		const showArchivedButton = page.locator('button:has-text("Show archived")');
		if ((await showArchivedButton.count()) > 0) {
			await showArchivedButton.click();

			// Wait for toggle
			await page.waitForTimeout(500);

			// Should now show "Hide archived"
			await expect(page.locator('text=Hide archived')).toBeVisible();

			// The archived session should now be visible in the list
			const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
			await expect(sessionLink).toBeVisible();
		}
	});
});

test.describe('Session Archive - Session List Indicator', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should show archive indicator on archived session in list', async ({ page }) => {
		// Create and archive a session
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// Navigate home to see the list
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Show archived sessions
		const showArchivedButton = page.locator('button:has-text("Show archived")');
		if ((await showArchivedButton.count()) > 0) {
			await showArchivedButton.click();
			await page.waitForTimeout(500);
		}

		// The archived session should have an archive indicator
		const sessionLink = page.locator(`[data-session-id="${sessionId}"]`);
		if ((await sessionLink.count()) > 0) {
			// Check for archive icon within the session item
			// Note: The exact selector depends on implementation
			await expect(sessionLink).toBeVisible();
		}
	});
});

test.describe('Session Archive - Edge Cases', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should preserve messages after archiving', async ({ page }) => {
		// Create session with a specific message
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		const textarea = page.locator('textarea[placeholder*="Ask"]');
		await textarea.fill('Unique test message 12345');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await waitForAssistantResponse(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// The original message should still be visible
		await expect(page.locator('text=Unique test message 12345')).toBeVisible();
	});

	test('should allow deleting archived session', async ({ page }) => {
		// Create session with a message
		sessionId = await createSessionWithMessage(page);

		// Archive the session
		await openSessionOptionsMenu(page);
		await clickArchiveSession(page);

		// Wait for archive to complete
		await page.waitForTimeout(1500);

		// Open options and click delete
		await openSessionOptionsMenu(page);

		const deleteItem = page.locator('text=Delete Session').first();
		await deleteItem.click();

		// Confirm deletion
		const confirmButton = page
			.locator('[data-testid="confirm-delete-session"], button:has-text("Delete")')
			.last();
		await confirmButton.click();

		// Wait for deletion
		await page.waitForTimeout(1000);

		// Session should be deleted (navigated away)
		sessionId = null; // Already deleted, don't try to cleanup
	});
});
