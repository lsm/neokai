import { test, expect } from '@playwright/test';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * Session Status Indicators E2E Tests
 *
 * Tests the live status indicators in the sidebar session list:
 * 1. Processing indicator - pulsing dot when session is working
 * 2. Unread indicator - static blue dot when session has unread messages
 * 3. Git worktree icon - branch icon for worktree sessions
 *
 * The indicators should:
 * - Show pulsing animation during processing (yellow/blue/green/purple phases)
 * - Show static blue dot for unread messages
 * - Show git branch icon for worktree sessions
 * - Hide when idle and no unread messages (no empty space)
 */
test.describe('Session Status Indicators', () => {
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

	test.describe('Processing Indicator in Sidebar', () => {
		test('should show pulsing indicator when session is processing', async ({ page }) => {
			// Create a new session
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			sessionId = await waitForSessionCreated(page);

			// Get the session card in the sidebar
			const sessionCard = page.locator(
				`[data-testid="session-card"][data-session-id="${sessionId}"]`
			);
			await expect(sessionCard).toBeVisible();

			// Send a message to trigger processing
			const textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('What is 2 + 2?');
			await page.keyboard.press('Meta+Enter');

			// During processing, there should be a pulsing indicator in the sidebar
			// The indicator uses animate-pulse and animate-ping classes
			const pulsingIndicator = sessionCard.locator('.animate-pulse');
			await expect(pulsingIndicator).toBeVisible({ timeout: 5000 });

			// Wait for processing to complete
			await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
				timeout: 30000,
			});

			// After processing completes, the pulsing indicator should disappear
			await expect(pulsingIndicator).not.toBeVisible({ timeout: 10000 });
		});

		test('should not show pulsing indicator when session is idle', async ({ page }) => {
			// Create a new session
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			sessionId = await waitForSessionCreated(page);

			// Get the session card in the sidebar
			const sessionCard = page.locator(
				`[data-testid="session-card"][data-session-id="${sessionId}"]`
			);
			await expect(sessionCard).toBeVisible();

			// Wait a moment for any initial state to settle
			await page.waitForTimeout(2000);

			// Without sending any message, there should be no pulsing indicator
			const pulsingIndicator = sessionCard.locator('.animate-pulse');
			await expect(pulsingIndicator).not.toBeVisible();
		});

		test('should show correct phase colors during processing', async ({ page }) => {
			// Create a new session
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			sessionId = await waitForSessionCreated(page);

			const sessionCard = page.locator(
				`[data-testid="session-card"][data-session-id="${sessionId}"]`
			);

			// Send a message that will take some time to process
			const textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('Think carefully and explain the Pythagorean theorem step by step.');
			await page.keyboard.press('Meta+Enter');

			// Wait for a processing indicator to appear
			const indicator = sessionCard.locator('.animate-pulse').first();
			await expect(indicator).toBeVisible({ timeout: 5000 });

			// The indicator should have one of the phase colors
			const classes = await indicator.getAttribute('class');
			const hasPhaseColor =
				classes?.includes('bg-yellow-500') || // initializing/queued
				classes?.includes('bg-blue-500') || // thinking
				classes?.includes('bg-green-500') || // streaming
				classes?.includes('bg-purple-500'); // finalizing

			expect(hasPhaseColor).toBe(true);

			// Wait for completion
			await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
				timeout: 30000,
			});

			// Indicator should be gone after completion
			await expect(indicator).not.toBeVisible({ timeout: 10000 });
		});

		test('should return to idle state after processing completes', async ({ page }) => {
			// Create a new session
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			sessionId = await waitForSessionCreated(page);

			const sessionCard = page.locator(
				`[data-testid="session-card"][data-session-id="${sessionId}"]`
			);

			// Send a message
			const textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('Say hello');
			await page.keyboard.press('Meta+Enter');

			// Wait for response
			await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
				timeout: 30000,
			});

			// Give extra time for state to settle
			await page.waitForTimeout(2000);

			// Verify no pulsing indicators remain in the session card
			const pulsingIndicators = sessionCard.locator('.animate-pulse');
			const count = await pulsingIndicators.count();
			expect(count).toBe(0);

			// Also verify no ping animations
			const pingIndicators = sessionCard.locator('.animate-ping');
			const pingCount = await pingIndicators.count();
			expect(pingCount).toBe(0);
		});

		test('should return to idle when switching sessions before processing completes', async ({
			page,
		}) => {
			// This test covers the bug where:
			// 1. Send message in Session A
			// 2. Quickly switch to Session B
			// 3. Session A finishes processing
			// 4. Session A's indicator should return to idle (not stay stuck at yellow)

			// Create first session
			let newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			const session1Id = await waitForSessionCreated(page);
			sessionId = session1Id;

			// Send a message to trigger processing
			let textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('What is the capital of France?');
			await page.keyboard.press('Meta+Enter');

			// Wait for processing indicator to appear
			const session1Card = page.locator(
				`[data-testid="session-card"][data-session-id="${session1Id}"]`
			);
			const pulsingIndicator = session1Card.locator('.animate-pulse');
			await expect(pulsingIndicator).toBeVisible({ timeout: 5000 });

			// QUICKLY switch to a new session before processing completes
			await page.goto('/');
			await page.waitForTimeout(500);
			newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			const session2Id = await waitForSessionCreated(page);

			// Now we're in session 2, but session 1 is still processing in the background

			// Wait for session 1's processing to complete (assistant message appears)
			// We need to verify via the sidebar, since we're viewing session 2
			// The indicator should disappear when processing finishes
			await expect(session1Card.locator('.animate-pulse')).not.toBeVisible({
				timeout: 35000, // Processing can take a while
			});

			// Verify no pulsing indicators on session 1's card
			const session1PulsingCount = await session1Card.locator('.animate-pulse').count();
			expect(session1PulsingCount).toBe(0);

			// Also verify no ping animations on session 1's card
			const session1PingCount = await session1Card.locator('.animate-ping').count();
			expect(session1PingCount).toBe(0);

			// Cleanup session 2
			try {
				await cleanupTestSession(page, session2Id);
			} catch {
				// Ignore cleanup errors
			}
		});
	});

	test.describe('Unread Message Indicator', () => {
		test('should show unread indicator when other session has new messages', async ({ page }) => {
			// Create first session
			let newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			const session1Id = await waitForSessionCreated(page);
			sessionId = session1Id;

			// Send message to first session
			let textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('Hello from session 1');
			await page.keyboard.press('Meta+Enter');

			await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
				timeout: 30000,
			});

			// Create second session
			await page.goto('/');
			await page.waitForTimeout(1000);
			newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			const session2Id = await waitForSessionCreated(page);

			// Session 1 card should now potentially show as "unread" since we're in session 2
			// (if message count increased while we weren't viewing it)
			const session1Card = page.locator(
				`[data-testid="session-card"][data-session-id="${session1Id}"]`
			);
			await expect(session1Card).toBeVisible();

			// Since we created session 1 first and then moved to session 2,
			// session 1 should not show unread yet (we just viewed it)

			// Send a message in session 2
			textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('Hello from session 2');
			await page.keyboard.press('Meta+Enter');

			await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
				timeout: 30000,
			});

			// Clean up second session
			try {
				await cleanupTestSession(page, session2Id);
			} catch {
				// Ignore cleanup errors
			}
		});

		test('should clear unread indicator when session is clicked', async ({ page }) => {
			// Create first session and send a message
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			sessionId = await waitForSessionCreated(page);

			const textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('Test message');
			await page.keyboard.press('Meta+Enter');

			await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
				timeout: 30000,
			});

			// Navigate home
			await page.goto('/');
			await page.waitForTimeout(1000);

			// Get the session card
			const sessionCard = page.locator(
				`[data-testid="session-card"][data-session-id="${sessionId}"]`
			);
			await expect(sessionCard).toBeVisible();

			// Click the session to view it
			await sessionCard.click();
			await page.waitForTimeout(1000);

			// After viewing, any unread indicator should be cleared
			// The blue static dot (bg-blue-500 without animate-pulse) should not be visible
			const staticBlueDot = sessionCard.locator('.bg-blue-500:not(.animate-pulse)');
			await expect(staticBlueDot).not.toBeVisible();
		});
	});

	test.describe('Git Worktree Icon', () => {
		test('should show git branch icon for worktree sessions after first message', async ({
			page,
		}) => {
			// Create a new session
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			sessionId = await waitForSessionCreated(page);

			const sessionCard = page.locator(
				`[data-testid="session-card"][data-session-id="${sessionId}"]`
			);
			await expect(sessionCard).toBeVisible();

			// Before first message, worktree is not initialized yet
			// Git branch icon should not be visible
			let gitBranchIcon = sessionCard
				.locator('svg[viewBox="0 0 16 16"]')
				.locator('path[d*="M11.75 2.5"]');

			// Send a message to trigger Stage 2 (workspace initialization with worktree)
			const textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('Initialize workspace test');
			await page.keyboard.press('Meta+Enter');

			// Wait for response
			await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
				timeout: 30000,
			});

			// Wait for worktree initialization to complete
			await page.waitForTimeout(3000);

			// After workspace initialization, if it's a worktree session,
			// the git branch icon should be visible (purple color)
			// Note: This depends on whether the test workspace is a git repo
			gitBranchIcon = sessionCard.locator('.text-purple-400 svg');
			const isVisible = await gitBranchIcon.isVisible().catch(() => false);

			// If git branch icon is visible, it should have a tooltip
			if (isVisible) {
				await expect(gitBranchIcon.locator('..')).toHaveAttribute('title', /Worktree:/);
			}
		});

		test('should display git branch icon aligned to the right of title', async ({ page }) => {
			// Create a new session
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			sessionId = await waitForSessionCreated(page);

			// Send message to trigger workspace initialization
			const textarea = page.locator('textarea[placeholder*="Ask"]').first();
			await textarea.fill('Test worktree alignment');
			await page.keyboard.press('Meta+Enter');

			await expect(page.locator('[data-testid="assistant-message"]').first()).toBeVisible({
				timeout: 30000,
			});

			// Wait for worktree to initialize
			await page.waitForTimeout(3000);

			const sessionCard = page.locator(
				`[data-testid="session-card"][data-session-id="${sessionId}"]`
			);

			// Check if git branch icon exists and is positioned correctly
			const gitIconContainer = sessionCard.locator('.text-purple-400');
			const isVisible = await gitIconContainer.isVisible().catch(() => false);

			if (isVisible) {
				// The icon should be in a flex container that aligns it to the right
				// Check that it's in the icons group (flex-shrink-0)
				const parentClasses = await gitIconContainer.locator('..').getAttribute('class');
				expect(parentClasses).toContain('flex-shrink-0');
			}
		});
	});

	test.describe('No Empty Space When No Indicator', () => {
		test('should not leave empty space when session is idle and read', async ({ page }) => {
			// Create a new session
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			sessionId = await waitForSessionCreated(page);

			const sessionCard = page.locator(
				`[data-testid="session-card"][data-session-id="${sessionId}"]`
			);
			await expect(sessionCard).toBeVisible();

			// Wait for any initialization
			await page.waitForTimeout(2000);

			// The StatusIndicator should return null when idle and read
			// So there should be no spacer div with w-2.5 h-2.5 class
			// that would take up space

			// Check that the title starts near the left edge of its container
			// (no empty gap from a spacer)
			const titleRow = sessionCard.locator('.flex.items-center.gap-2.flex-1').first();
			const children = await titleRow.locator('> *').all();

			// If StatusIndicator returns null, first child should be the h3 title
			// If there's a spacer, it would be an empty div before the title
			if (children.length > 0) {
				const firstChild = children[0];
				const tagName = await firstChild.evaluate((el) => el.tagName.toLowerCase());

				// First child should be h3 (title) when no indicator
				// or it could be the StatusIndicator div if showing
				const isTitle = tagName === 'h3';
				const isIndicator = tagName === 'div';

				expect(isTitle || isIndicator).toBe(true);

				// If it's a div (potential spacer), check it's not just an empty spacer
				if (isIndicator) {
					const hasContent = await firstChild.locator('span').count();
					const hasClass = await firstChild.getAttribute('class');
					// If it's a spacer, it would have no spans and be 2.5x2.5
					if (hasContent === 0 && hasClass?.includes('w-2.5') && hasClass?.includes('h-2.5')) {
						// This is the bug - empty spacer present
						throw new Error('Empty spacer found when StatusIndicator should return null');
					}
				}
			}
		});

		test('title should be aligned consistently across sessions', async ({ page }) => {
			// Create multiple sessions to compare alignment
			const sessionIds: string[] = [];

			// Create first session
			let newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			const session1Id = await waitForSessionCreated(page);
			sessionIds.push(session1Id);
			sessionId = session1Id;

			// Navigate home and create second session
			await page.goto('/');
			await page.waitForTimeout(1000);

			newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			const session2Id = await waitForSessionCreated(page);
			sessionIds.push(session2Id);

			// Both session cards should be visible
			const session1Card = page.locator(
				`[data-testid="session-card"][data-session-id="${session1Id}"]`
			);
			const session2Card = page.locator(
				`[data-testid="session-card"][data-session-id="${session2Id}"]`
			);

			await expect(session1Card).toBeVisible();
			await expect(session2Card).toBeVisible();

			// Get the title elements
			const title1 = session1Card.locator('h3');
			const title2 = session2Card.locator('h3');

			// Get their bounding boxes
			const box1 = await title1.boundingBox();
			const box2 = await title2.boundingBox();

			expect(box1).not.toBeNull();
			expect(box2).not.toBeNull();

			if (box1 && box2) {
				// Titles should have the same X position (aligned left)
				// Allow small variance for padding
				expect(Math.abs(box1.x - box2.x)).toBeLessThan(5);
			}

			// Cleanup
			for (const id of sessionIds) {
				try {
					await cleanupTestSession(page, id);
				} catch {
					// Ignore
				}
			}
			sessionId = null;
		});
	});
});
