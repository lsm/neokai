/**
 * Interrupt Error Bug E2E Tests
 *
 * Tests for interrupt-related bugs that should FAIL until fixed:
 * 1. Race condition requiring agent reset after interrupt (ISSUE 2)
 *
 * Root cause identified:
 * - Issue 2: ensureQueryStarted() checks queryPromise which still exists after handleInterrupt()
 *
 * Issue 1 (3 error notifications) appears to be intermittent and scenario-specific,
 * making it difficult to reliably reproduce in E2E tests. The primary focus is on
 * the race condition bug which is consistently reproduced.
 *
 * Reference: https://github.com/anthropics/liuboer/issues/XXX
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Interrupt Error Bug', () => {
	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
	});

	test.describe('Issue: Race Condition Requiring Reset', () => {
		test('should allow sending messages immediately after interrupt without reset', async ({
			page,
		}) => {
			// This test FAILS when race condition prevents message processing (the bug)
			// The bug: handleInterrupt() returns immediately without awaiting query cleanup,
			// so queryPromise still exists when user sends a new message, causing
			// ensureQueryStarted() to return early without starting a new query.

			// Create a session
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);

			// Send first message
			const messageInput = await waitForElement(page, 'textarea');
			await messageInput.fill('Write a detailed essay about quantum computing.');
			await page.click('[data-testid="send-button"]');

			const stopButton = page.locator('[data-testid="stop-button"]');
			await expect(stopButton).toBeVisible({ timeout: 10000 });

			// Interrupt
			await stopButton.click();
			await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 15000 });

			// IMMEDIATELY send new message (triggers race condition)
			// This timing is critical - must happen before query cleanup completes
			await page.waitForTimeout(200);
			await messageInput.fill('Reply with exactly: AFTER_INTERRUPT_OK');
			await page.click('[data-testid="send-button"]');

			// Wait for response
			const responseReceived = await page
				.locator('text=/AFTER_INTERRUPT_OK/i')
				.isVisible({ timeout: 20000 })
				.catch(() => false);

			console.log('Response received:', responseReceived);

			// Check agent state
			const agentState = await page.evaluate(() => {
				const state = window.sessionStore?.sessionState?.value;
				return state?.agentState || null;
			});

			console.log('Agent state:', agentState);

			// This assertion FAILS when race condition prevents response (bug)
			expect(responseReceived).toBe(true);

			await cleanupTestSession(page, sessionId);
		});

		test('should not require reset button after interrupt and new message', async ({ page }) => {
			// This test FAILS when agent gets stuck after interrupt (the bug)
			// Create a session
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);

			// Send first message and interrupt
			const messageInput = await waitForElement(page, 'textarea');
			await messageInput.fill('Explain neural networks in depth.');
			await page.click('[data-testid="send-button"]');

			await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 10000 });

			// Interrupt
			await page.click('[data-testid="stop-button"]');

			// Send another message IMMEDIATELY (triggers race condition)
			// No wait - send as soon as possible after interrupt
			await messageInput.fill('Hello after interrupt');
			await page.click('[data-testid="send-button"]');

			// Wait briefly for message to appear
			await page.waitForTimeout(1000);

			// Check agent state IMMEDIATELY after sending
			// If race condition exists, agent will be stuck in processing
			const agentStateImmediate = await page.evaluate(() => {
				const state = window.sessionStore?.sessionState?.value;
				return state?.agentState?.status || null;
			});

			console.log('Agent status (immediate):', agentStateImmediate);

			// Wait for processing - if bug exists, agent gets stuck
			const sendButtonVisible = await page
				.locator('[data-testid="send-button"]')
				.isVisible({ timeout: 30000 })
				.catch(() => false);

			console.log('Send button visible:', sendButtonVisible);

			// Also check if agent is stuck
			const agentState = await page.evaluate(() => {
				const state = window.sessionStore?.sessionState?.value;
				return state?.agentState?.status || null;
			});

			console.log('Agent status (after wait):', agentState);

			// This assertion FAILS when agent is stuck (bug)
			expect(sendButtonVisible).toBe(true);

			// Agent should not be stuck in processing
			expect(agentState).not.toBe('processing');

			await cleanupTestSession(page, sessionId);
		});

		test('should handle rapid interrupt-then-send sequence', async ({ page }) => {
			// This test FAILS when rapid interrupt-then-send causes race condition (the bug)
			// Create a session
			await page.getByRole('button', { name: 'New Session', exact: true }).click();
			const sessionId = await waitForSessionCreated(page);

			// Send message
			const messageInput = await waitForElement(page, 'textarea');
			await messageInput.fill('Write about blockchain technology.');
			await page.click('[data-testid="send-button"]');

			await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 10000 });

			// Interrupt
			await page.click('[data-testid="stop-button"]');

			// IMMEDIATELY send new message (within 50ms) - maximizes chance of race condition
			await page.waitForTimeout(50);
			await messageInput.fill('Quick message after interrupt');
			await page.click('[data-testid="send-button"]');

			// Track processing time
			const startTime = Date.now();

			// Wait for user message to appear
			await expect(page.locator('text=/Quick message/i')).toBeVisible({ timeout: 5000 });

			// Wait for assistant response
			const responseReceived = await page
				.locator('text=/blockchain|Block chain|Blockchain/i')
				.isVisible({ timeout: 20000 })
				.catch(() => false);

			const elapsed = Date.now() - startTime;
			console.log('Response received:', responseReceived);
			console.log('Time elapsed:', elapsed, 'ms');

			// Check agent state
			const agentInfo = await page.evaluate(() => {
				const state = window.sessionStore?.sessionState?.value;
				return {
					status: state?.agentState?.status || null,
					messageId: state?.agentState?.messageId || null,
				};
			});

			console.log('Agent info:', agentInfo);

			// This assertion FAILS when agent is stuck in processing state (bug)
			expect(agentInfo.status).not.toBe('processing');

			// Processing should complete in reasonable time
			expect(elapsed).toBeLessThan(15000);

			await cleanupTestSession(page, sessionId);
		});
	});
});
