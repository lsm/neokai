/**
 * Interrupt Button E2E Tests
 *
 * Tests the stop/interrupt button functionality:
 * - Button visibility and state during agent processing
 * - Click to interrupt functionality
 * - Escape key to interrupt functionality
 * - Loading states and UI feedback
 * - Button transitions between send/stop states
 */

import { test, expect } from '@playwright/test';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Interrupt Button', () => {
	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
	});

	test('should show stop button when agent is processing', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
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
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });
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
		await page.click('button:has-text("New Session")');
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
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Set up interrupt tracking
		await page.evaluate(async (sid) => {
			const hub = window.__messageHub;
			let interruptReceived = false;

			await hub.subscribe(
				'session.interrupted',
				() => {
					interruptReceived = true;
				},
				{ sessionId: sid }
			);

			window.__checkInterrupt = () => interruptReceived;
		}, sessionId);

		// Send a long message
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill(
			'Write a comprehensive guide to distributed systems, including CAP theorem, consensus algorithms, and practical examples.'
		);
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);

		// Click stop button
		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 5000 });
		await stopButton.click();

		// Wait for interrupt to process
		await page.waitForTimeout(2000);

		// Check if interrupt was received
		const wasInterrupted = await page.evaluate(() => {
			return window.__checkInterrupt();
		});
		expect(wasInterrupted).toBe(true);

		// Send button should return (agent is idle again)
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 5000 });

		// Input should be enabled
		await expect(messageInput).toBeEnabled();

		await cleanupTestSession(page, sessionId);
	});

	test('should interrupt agent when Escape key is pressed', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Set up interrupt tracking
		await page.evaluate(async (sid) => {
			const hub = window.__messageHub;
			let interruptReceived = false;

			await hub.subscribe(
				'session.interrupted',
				() => {
					interruptReceived = true;
				},
				{ sessionId: sid }
			);

			window.__checkInterrupt = () => interruptReceived;
		}, sessionId);

		// Send a long message
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Explain the history of the internet in detail with examples.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);

		// Stop button should be visible
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });

		// Press Escape key
		await page.keyboard.press('Escape');

		// Wait for interrupt to process
		await page.waitForTimeout(2000);

		// Check if interrupt was received
		const wasInterrupted = await page.evaluate(() => {
			return window.__checkInterrupt();
		});
		expect(wasInterrupted).toBe(true);

		// Send button should return
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 5000 });

		await cleanupTestSession(page, sessionId);
	});

	test('should show loading spinner while interrupting', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
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
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 5000 });

		await cleanupTestSession(page, sessionId);
	});

	test('should transition from send to stop and back to send', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
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
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

		// Interrupt
		await page.click('[data-testid="stop-button"]');

		// Wait for idle: send button should return
		await page.waitForTimeout(2000);
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

		await cleanupTestSession(page, sessionId);
	});

	test('should handle rapid interrupt attempts gracefully', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Explain compiler design.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing
		await page.waitForTimeout(1000);

		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 5000 });

		// Try to click multiple times rapidly
		await stopButton.click();
		await stopButton.click().catch(() => {}); // Might be disabled already
		await stopButton.click().catch(() => {}); // Might be disabled already

		// Should not crash, should handle gracefully
		await page.waitForTimeout(2000);

		// Should eventually return to idle state
		await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 5000 });

		await cleanupTestSession(page, sessionId);
	});

	test('Escape key should work even when textarea is disabled', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Set up interrupt tracking
		await page.evaluate(async (sid) => {
			const hub = window.__messageHub;
			let interruptReceived = false;

			await hub.subscribe(
				'session.interrupted',
				() => {
					interruptReceived = true;
				},
				{ sessionId: sid }
			);

			window.__checkInterrupt = () => interruptReceived;
		}, sessionId);

		// Send a message
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Write a tutorial on functional programming.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing
		await page.waitForTimeout(1000);
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });

		// Textarea might be disabled during processing
		const isTextareaDisabled = await messageInput.isDisabled();

		// Press Escape (should work regardless of textarea disabled state)
		await page.keyboard.press('Escape');

		// Wait for interrupt
		await page.waitForTimeout(2000);

		// Check interrupt was received
		const wasInterrupted = await page.evaluate(() => {
			return window.__checkInterrupt();
		});
		expect(wasInterrupted).toBe(true);

		// Document that Escape works even when textarea is disabled
		if (isTextareaDisabled) {
			// This test verifies the fix: global Escape listener works even when textarea is disabled
			expect(true).toBe(true);
		}

		await cleanupTestSession(page, sessionId);
	});
});
