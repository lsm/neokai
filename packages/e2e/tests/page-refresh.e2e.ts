/**
 * Page Refresh E2E Tests
 *
 * Tests persistence and restoration of session state across page refreshes.
 * Verifies that:
 * - Context information persists and displays correctly
 * - Session metadata (tokens, costs, tool calls) persists
 * - Agent state properly resets to idle (expected behavior)
 * - Slash commands remain available from database
 * - Full session state is restored accurately
 */

import { test, expect } from '@playwright/test';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForMessageProcessed,
	cleanupTestSession,
	waitForElement,
} from './helpers/wait-helpers';

test.describe('Page Refresh Persistence', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
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

	test('should restore context info percentage after refresh', async ({ page }) => {
		// Create session and send message
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);
		expect(sessionId).toBeTruthy();

		// Send a message to generate context
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Hello! Please respond briefly.');
		await messageInput.press('Enter');

		// Wait for processing to complete
		await waitForMessageProcessed(page, 'Hello! Please respond briefly.');

		// Wait for context indicator to show percentage
		await page.waitForFunction(
			() => {
				const contextEl = document.querySelector('span[class*="text-"][class*="-400"]');
				const contextText = contextEl?.textContent || '';
				// Check for percentage format: X.X% or <0.1%
				return /\d+\.\d+%|<\d+\.\d+%/.test(contextText);
			},
			{ timeout: 10000 }
		);

		// Capture context percentage before refresh
		const contextPercentageBefore = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return null;

			// Get the first session's context
			const firstSession = Array.from(sessionState.values())[0];
			const context = firstSession?.context?.$.value as { percentUsed?: number } | undefined;
			return context?.percentUsed || null;
		});

		expect(contextPercentageBefore).not.toBeNull();
		expect(contextPercentageBefore).toBeGreaterThan(0);

		// Refresh the page
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to the session
		await page.goto(`/${sessionId}`);

		// Wait for session to load
		await waitForElement(page, 'textarea[placeholder*="Ask"]');

		// Wait for context to be restored
		await page.waitForFunction(
			() => {
				const sessionState = window.appState?.sessions;
				if (!sessionState) return false;

				const firstSession = Array.from(sessionState.values())[0];
				const context = firstSession?.context?.$.value as { percentUsed?: number } | undefined;
				return (context?.percentUsed || 0) > 0;
			},
			{ timeout: 10000 }
		);

		// Capture context percentage after refresh
		const contextPercentageAfter = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return null;

			const firstSession = Array.from(sessionState.values())[0];
			const context = firstSession?.context?.$.value as { percentUsed?: number } | undefined;
			return context?.percentUsed || null;
		});

		// Verify context percentage is restored
		expect(contextPercentageAfter).toBe(contextPercentageBefore);

		// Verify context indicator is visible with correct value
		const contextIndicator = page.locator('span[class*="text-"][class*="-400"]').first();
		await expect(contextIndicator).toBeVisible();

		const contextText = await contextIndicator.textContent();
		expect(contextText).toMatch(/\d+\.\d+%|<\d+\.\d+%/);
	});

	test('should persist token counts and metadata after refresh', async ({ page }) => {
		// Create session and send message
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Write a brief explanation of TypeScript.');
		await messageInput.press('Enter');

		// Wait for processing
		await waitForMessageProcessed(page, 'Write a brief explanation of TypeScript.');

		// Wait for context to be updated
		await page.waitForFunction(
			() => {
				const sessionState = window.appState?.sessions;
				if (!sessionState) return false;

				const firstSession = Array.from(sessionState.values())[0];
				const context = firstSession?.context?.$.value as { totalUsed?: number } | undefined;
				return (context?.totalUsed || 0) > 0;
			},
			{ timeout: 10000 }
		);

		// Capture metadata before refresh
		const metadataBefore = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return null;

			const firstSession = Array.from(sessionState.values())[0];
			const context = firstSession?.context?.$.value as
				| {
						totalUsed?: number;
						totalCapacity?: number;
						percentUsed?: number;
						model?: string;
				  }
				| undefined;

			return {
				totalUsed: context?.totalUsed || 0,
				totalCapacity: context?.totalCapacity || 0,
				percentUsed: context?.percentUsed || 0,
				model: context?.model || '',
			};
		});

		expect(metadataBefore).not.toBeNull();
		expect(metadataBefore.totalUsed).toBeGreaterThan(0);

		// Refresh page
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to session
		await page.goto(`/${sessionId}`);
		await waitForElement(page, 'textarea[placeholder*="Ask"]');

		// Wait for context to be restored
		await page.waitForFunction(
			() => {
				const sessionState = window.appState?.sessions;
				if (!sessionState) return false;

				const firstSession = Array.from(sessionState.values())[0];
				const context = firstSession?.context?.$.value as { totalUsed?: number } | undefined;
				return (context?.totalUsed || 0) > 0;
			},
			{ timeout: 10000 }
		);

		// Capture metadata after refresh
		const metadataAfter = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return null;

			const firstSession = Array.from(sessionState.values())[0];
			const context = firstSession?.context?.$.value as
				| {
						totalUsed?: number;
						totalCapacity?: number;
						percentUsed?: number;
						model?: string;
				  }
				| undefined;

			return {
				totalUsed: context?.totalUsed || 0,
				totalCapacity: context?.totalCapacity || 0,
				percentUsed: context?.percentUsed || 0,
				model: context?.model || '',
			};
		});

		// Verify all metadata matches
		expect(metadataAfter.totalUsed).toBe(metadataBefore.totalUsed);
		expect(metadataAfter.totalCapacity).toBe(metadataBefore.totalCapacity);
		expect(metadataAfter.percentUsed).toBe(metadataBefore.percentUsed);
		expect(metadataAfter.model).toBe(metadataBefore.model);
	});

	test('should reset agent state to idle after refresh (expected behavior)', async ({ page }) => {
		// Create session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send a message
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Tell me a short story.');

		const sendButton = page.locator('button[type="submit"]');
		await sendButton.click();

		// Wait for processing to start
		await page.waitForFunction(
			() => {
				const input = document.querySelector('textarea[placeholder*="Ask"]') as HTMLTextAreaElement;
				return input && input.disabled;
			},
			{ timeout: 5000 }
		);

		// Verify agent is processing
		const agentStateBefore = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return null;

			const firstSession = Array.from(sessionState.values())[0];
			const agent = firstSession?.agent?.$.value as { status?: string } | undefined;
			return agent?.status || 'unknown';
		});

		// Agent should be in processing state (or might have just finished)
		expect(['processing', 'idle']).toContain(agentStateBefore);

		// Refresh page during or right after processing
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to session
		await page.goto(`/${sessionId}`);
		await waitForElement(page, 'textarea[placeholder*="Ask"]');

		// Verify agent state is idle (expected behavior - state resets on refresh)
		const agentStateAfter = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return null;

			const firstSession = Array.from(sessionState.values())[0];
			const agent = firstSession?.agent?.$.value as { status?: string } | undefined;
			return agent?.status || 'idle';
		});

		// Agent state should reset to idle after refresh
		expect(agentStateAfter).toBe('idle');

		// Input should be enabled (not processing)
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(input).toBeEnabled();
	});

	test('should restore slash commands immediately after refresh', async ({ page }) => {
		// Create session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Wait for commands to load
		await page.waitForFunction(
			() => {
				const sessionState = window.appState?.sessions;
				if (!sessionState) return false;

				const firstSession = Array.from(sessionState.values())[0];
				const commands = firstSession?.commands?.$.value as
					| { availableCommands?: string[] }
					| undefined;
				return (commands?.availableCommands || []).length > 0;
			},
			{ timeout: 10000 }
		);

		// Capture commands before refresh
		const commandsBefore = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return [];

			const firstSession = Array.from(sessionState.values())[0];
			const commands = firstSession?.commands?.$.value as
				| { availableCommands?: string[] }
				| undefined;
			return commands?.availableCommands || [];
		});

		expect(commandsBefore.length).toBeGreaterThan(0);

		// Refresh page
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to session
		await page.goto(`/${sessionId}`);
		await waitForElement(page, 'textarea[placeholder*="Ask"]');

		// Wait for commands to be restored
		await page.waitForFunction(
			() => {
				const sessionState = window.appState?.sessions;
				if (!sessionState) return false;

				const firstSession = Array.from(sessionState.values())[0];
				const commands = firstSession?.commands?.$.value as
					| { availableCommands?: string[] }
					| undefined;
				return (commands?.availableCommands || []).length > 0;
			},
			{ timeout: 10000 }
		);

		// Capture commands after refresh
		const commandsAfter = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return [];

			const firstSession = Array.from(sessionState.values())[0];
			const commands = firstSession?.commands?.$.value as
				| { availableCommands?: string[] }
				| undefined;
			return commands?.availableCommands || [];
		});

		// Commands should be available immediately (from DB)
		expect(commandsAfter.length).toBeGreaterThan(0);
		expect(commandsAfter).toEqual(commandsBefore);
	});

	test('should restore full session state including messages and title', async ({ page }) => {
		// Create session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send message and wait for title generation
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('What is React and why is it popular?');
		await messageInput.press('Enter');

		// Wait for message processing
		await waitForMessageProcessed(page, 'What is React and why is it popular?');

		// Wait for title to be generated
		const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
		await page.waitForFunction(
			(sid) => {
				const sessionEl = document.querySelector(`[data-session-id="${sid}"]`);
				const titleEl = sessionEl?.querySelector('h3');
				const titleText = titleEl?.textContent || '';
				return titleText !== 'New Session' && titleText.length > 0;
			},
			sessionId,
			{ timeout: 15000 }
		);

		// Capture session state before refresh
		const stateBefore = await page.evaluate(() => {
			const sessionsList = window.appState?.global?.value?.sessions?.$.value?.sessions || [];
			const session = sessionsList.find((s) => s.id === location.pathname.split('/')[1]);

			if (!session) return null;

			return {
				title: session.title,
				id: session.id,
			};
		});

		expect(stateBefore).not.toBeNull();
		expect(stateBefore.title).not.toBe('New Session');

		// Count messages before refresh
		const messageCountBefore = await page.locator('[data-message-role]').count();
		expect(messageCountBefore).toBeGreaterThanOrEqual(2); // At least 1 user + 1 assistant

		// Refresh page
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to session
		await page.goto(`/${sessionId}`);
		await waitForElement(page, 'textarea[placeholder*="Ask"]');

		// Wait for messages to be restored
		await page.waitForFunction(
			(expectedCount) => {
				const messages = document.querySelectorAll('[data-message-role]');
				return messages.length >= expectedCount;
			},
			messageCountBefore,
			{ timeout: 10000 }
		);

		// Verify message count is restored
		const messageCountAfter = await page.locator('[data-message-role]').count();
		expect(messageCountAfter).toBe(messageCountBefore);

		// Verify original message is still visible
		await expect(page.locator('text=What is React and why is it popular?')).toBeVisible();

		// Verify session title is restored in sidebar
		await expect(sessionItem).toBeVisible();
		const titleAfter = await sessionItem.locator('h3').textContent();
		expect(titleAfter).toBe(stateBefore.title);
	});

	test('should restore context breakdown details after refresh', async ({ page }) => {
		// Create session and send message
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Send a message to generate context
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Explain closures in JavaScript.');
		await messageInput.press('Enter');

		// Wait for processing
		await waitForMessageProcessed(page, 'Explain closures in JavaScript.');

		// Wait for context to be updated
		await page.waitForFunction(
			() => {
				const sessionState = window.appState?.sessions;
				if (!sessionState) return false;

				const firstSession = Array.from(sessionState.values())[0];
				const context = firstSession?.context?.$.value as
					| { breakdown?: Record<string, unknown> }
					| undefined;
				return context?.breakdown !== null && context?.breakdown !== undefined;
			},
			{ timeout: 10000 }
		);

		// Capture context breakdown before refresh
		const breakdownBefore = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return null;

			const firstSession = Array.from(sessionState.values())[0];
			const context = firstSession?.context?.$.value as
				| {
						breakdown?: Record<string, { tokens: number; percent: number | null }>;
				  }
				| undefined;

			if (!context?.breakdown) return null;

			// Convert breakdown to serializable format
			const result: Record<string, { tokens: number; percent: number | null }> = {};
			for (const [key, value] of Object.entries(context.breakdown)) {
				result[key] = {
					tokens: value.tokens,
					percent: value.percent,
				};
			}
			return result;
		});

		expect(breakdownBefore).not.toBeNull();
		expect(Object.keys(breakdownBefore || {}).length).toBeGreaterThan(0);

		// Refresh page
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to session
		await page.goto(`/${sessionId}`);
		await waitForElement(page, 'textarea[placeholder*="Ask"]');

		// Wait for context breakdown to be restored
		await page.waitForFunction(
			() => {
				const sessionState = window.appState?.sessions;
				if (!sessionState) return false;

				const firstSession = Array.from(sessionState.values())[0];
				const context = firstSession?.context?.$.value as
					| { breakdown?: Record<string, unknown> }
					| undefined;
				return context?.breakdown !== null && context?.breakdown !== undefined;
			},
			{ timeout: 10000 }
		);

		// Capture context breakdown after refresh
		const breakdownAfter = await page.evaluate(() => {
			const sessionState = window.appState?.sessions;
			if (!sessionState) return null;

			const firstSession = Array.from(sessionState.values())[0];
			const context = firstSession?.context?.$.value as
				| {
						breakdown?: Record<string, { tokens: number; percent: number | null }>;
				  }
				| undefined;

			if (!context?.breakdown) return null;

			// Convert breakdown to serializable format
			const result: Record<string, { tokens: number; percent: number | null }> = {};
			for (const [key, value] of Object.entries(context.breakdown)) {
				result[key] = {
					tokens: value.tokens,
					percent: value.percent,
				};
			}
			return result;
		});

		// Verify breakdown is restored
		expect(breakdownAfter).not.toBeNull();
		expect(breakdownAfter).toEqual(breakdownBefore);

		// Verify context details can be opened
		const contextIndicator = page.locator('span[class*="text-"][class*="-400"]').first();
		await contextIndicator.click();

		// Context details dropdown should be visible
		await expect(page.locator('h3:has-text("Context Usage")')).toBeVisible();

		// Breakdown section should be visible
		await expect(page.locator('h4:has-text("Breakdown")')).toBeVisible();
	});
});
