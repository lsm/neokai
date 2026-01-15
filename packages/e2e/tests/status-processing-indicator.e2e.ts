/**
 * Processing Indicator in Sidebar - E2E Tests
 *
 * Tests the pulsing indicator that appears in the sidebar when a session is processing.
 * The indicator shows different colors (yellow/blue/green/purple) for different phases.
 */

import { test, expect } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

test.describe('Processing Indicator in Sidebar', () => {
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
		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
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
		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
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
		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
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
