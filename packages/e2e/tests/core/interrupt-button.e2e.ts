/**
 * Interrupt Button E2E Tests
 *
 * Tests the stop/interrupt button functionality:
 * - Button visibility and state during agent processing
 * - Click to interrupt functionality
 * - Loading states and UI feedback
 * - Button transitions between send/stop states
 */

import { test, expect } from '../../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from '../helpers/wait-helpers';

test.describe('Interrupt Button', () => {
	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
	});

	test('should show stop button when agent is processing', async ({ page }) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);

		// Initial state: should show send button (disabled, no content)
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
		await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

		// Send a message that will take time to process
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Write a detailed essay about quantum computing.');
		await page.click('[data-testid="send-button"]');

		// Wait for agent to start processing
		await page.waitForTimeout(1000);

		// Stop button should now be visible, send button hidden
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

		// Interrupt to clean up
		await page.click('[data-testid="stop-button"]');
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});

	test('should have clickable stop button (not disabled) when agent is processing', async ({
		page,
	}) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Explain machine learning in detail.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);

		// Stop button should be visible
		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 5000 });

		// CRITICAL: Stop button should NOT be disabled
		await expect(stopButton).toBeEnabled();

		// Verify it's not grayed out by checking it doesn't have disabled class
		const isGrayedOut = await stopButton.evaluate((el) => {
			const classes = el.className;
			return classes.includes('cursor-not-allowed') || classes.includes('opacity-50');
		});
		expect(isGrayedOut).toBe(false);

		// Verify it has the red color (not gray)
		const hasRedBackground = await stopButton.evaluate((el) => {
			const classes = el.className;
			return classes.includes('bg-red-500');
		});
		expect(hasRedBackground).toBe(true);

		// Clean up
		await stopButton.click();
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});

	test('should interrupt agent when stop button is clicked', async ({ page }) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);

		// Send a long message
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill(
			'Write a comprehensive guide to distributed systems, including CAP theorem, consensus algorithms, and practical examples.'
		);
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start - stop button should appear
		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 10000 });

		// Click stop button
		await stopButton.click();

		// Send button should return (agent is idle again) - this is the key indicator of successful interrupt
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
			timeout: 15000,
		});

		// Input should be enabled
		await expect(messageInput).toBeEnabled();

		await cleanupTestSession(page, sessionId);
	});

	test('should show loading spinner while interrupting', async ({ page }) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Explain neural networks in depth.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing
		await page.waitForTimeout(1000);

		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 5000 });

		// Click stop button
		await stopButton.click();

		// During interrupt, button should show spinner
		// Note: This might be very quick, so we check immediately after click
		const hasSpinner = await stopButton
			.locator('.animate-spin')
			.isVisible({ timeout: 500 })
			.catch(() => false);

		// Spinner might not be visible if interrupt was very fast, but button should be disabled
		const isDisabledDuringInterrupt = await stopButton.isDisabled().catch(() => false);

		// At least one should be true (spinner visible or button disabled)
		expect(hasSpinner || isDisabledDuringInterrupt).toBe(true);

		// Wait for interrupt to complete
		await page.waitForTimeout(1500);

		// Send button should return
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
			timeout: 5000,
		});

		await cleanupTestSession(page, sessionId);
	});

	test('should transition from send to stop and back to send', async ({ page }) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);

		const messageInput = await waitForElement(page, 'textarea');

		// Initial state: send button visible (but disabled due to no content)
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
		await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

		// Type message: send button should be enabled
		await messageInput.fill('Test message');
		await expect(page.locator('[data-testid="send-button"]')).toBeEnabled();

		// Send message
		await page.click('[data-testid="send-button"]');

		// Wait for processing: stop button should appear
		await page.waitForTimeout(1000);
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

		// Interrupt
		await page.click('[data-testid="stop-button"]');

		// Wait for idle: send button should return
		await page.waitForTimeout(2000);
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

		await cleanupTestSession(page, sessionId);
	});

	test.skip('should handle rapid interrupt attempts gracefully', async ({ page }) => {
		// TODO: This test is flaky because rapid clicks can cause the browser context to close unexpectedly
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);

		// Send a long message that will take time to process
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill(
			'Write an essay about climate change, including scientific evidence, political responses, and economic impacts. Make it comprehensive.'
		);
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 10000 });

		// Try to click multiple times rapidly - additional clicks may fail if button is already hidden
		await stopButton.click();
		await stopButton.click().catch(() => {});
		await stopButton.click().catch(() => {});

		// Should eventually return to idle state (send button visible)
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({
			timeout: 20000,
		});

		await cleanupTestSession(page, sessionId);
	});
});
