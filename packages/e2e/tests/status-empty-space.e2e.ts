/**
 * No Empty Space When No Indicator - E2E Tests
 *
 * Tests that the status indicator doesn't leave empty space when
 * the session is idle and has no unread messages.
 */

import { test, expect } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

test.describe('No Empty Space When No Indicator', () => {
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

	test('should not leave empty space when session is idle and read', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
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
		let newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		const session1Id = await waitForSessionCreated(page);
		sessionIds.push(session1Id);
		sessionId = session1Id;

		// Navigate home and create second session
		await page.goto('/');
		await page.waitForTimeout(1000);

		newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
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
