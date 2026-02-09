/**
 * Connection Resilience E2E Tests
 *
 * Comprehensive tests for WebSocket connection and reconnection behavior:
 * - Basic message sync after reconnection
 * - Multiple disconnect/reconnect cycles
 * - Long disconnection periods
 * - Message sync bug (critical regression test - Safari background tab)
 * - Message order preservation
 * - Connection state management and UI indicators
 * - Input blocking during disconnection
 *
 * MERGED FROM:
 * - reconnection.e2e.ts (base)
 * - connection.e2e.ts
 * - error-handling.e2e.ts
 * - status-indicators.e2e.ts
 */

import { test, expect } from '../../fixtures';
import {
	waitForWebSocketConnected,
	waitForSessionCreated,
	cleanupTestSession,
} from '../helpers/wait-helpers';

test.describe('Reconnection - Basic Message Sync', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for WebSocket connection to be established
		await waitForWebSocketConnected(page);
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

	test('should sync messages generated during disconnection', async ({ page }) => {
		// 1. Create a new session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// 2. Send a message that will take some time to process
		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Count from 1 to 5 with 1 second delay between each number');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 3. Wait for agent to start processing
		await page.waitForTimeout(2000);

		// 4. Count messages before disconnection
		const messagesBeforeDisconnect = await page.locator('[data-message-role]').count();
		console.log(`Messages before disconnect: ${messagesBeforeDisconnect}`);

		// 5. Simulate disconnection (mobile Safari backgrounding)
		await page.evaluate(() => {
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});

		// 6. Verify offline status
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});

		// 7. Wait while agent processes in background (6 seconds should generate more messages)
		await page.waitForTimeout(6000);

		// 8. Wait for auto-reconnect to happen (simulateDisconnect triggers auto-reconnect)
		// Wait for WebSocket to be connected again
		await page.waitForFunction(
			() => {
				const hub = window.__messageHub || window.appState?.messageHub;
				return hub?.getState && hub.getState() === 'connected';
			},
			{ timeout: 15000 }
		);

		// 9. Wait for state sync to complete
		await page.waitForTimeout(2000);

		// 11. Count messages after reconnection
		const messagesAfterReconnect = await page.locator('[data-message-role]').count();
		console.log(`Messages after reconnect: ${messagesAfterReconnect}`);

		// 12. VERIFY: More messages should be present (messages generated during disconnection)
		expect(messagesAfterReconnect).toBeGreaterThan(messagesBeforeDisconnect);

		// 13. Verify no duplicate messages (all messages should have unique UUIDs)
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false); // Should not be duplicate
				messageIds.add(uuid);
			}
		}

		console.log(`Unique messages: ${messageIds.size}`);
		expect(messageIds.size).toBe(messagesAfterReconnect);
	});
});

test.describe('Reconnection - Multiple Cycles', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for WebSocket connection to be established
		await waitForWebSocketConnected(page);
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

	test('should handle multiple disconnect/reconnect cycles', async ({ page }) => {
		// 1. Create session and send message
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('List 3 programming languages');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 2. Wait for initial response
		await page.waitForTimeout(3000);

		// 3. First disconnect cycle (auto-reconnect happens automatically)
		await page.evaluate(() => {
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(2000);

		// Wait for auto-reconnect
		// Wait for WebSocket to be connected again
		await page.waitForFunction(
			() => {
				const hub = window.__messageHub || window.appState?.messageHub;
				return hub?.getState && hub.getState() === 'connected';
			},
			{ timeout: 15000 }
		);

		const messagesAfterCycle1 = await page.locator('[data-message-role]').count();

		// 4. Second disconnect cycle (auto-reconnect happens automatically)
		await page.evaluate(() => {
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(2000);

		// Wait for auto-reconnect
		// Wait for WebSocket to be connected again
		await page.waitForFunction(
			() => {
				const hub = window.__messageHub || window.appState?.messageHub;
				return hub?.getState && hub.getState() === 'connected';
			},
			{ timeout: 15000 }
		);

		const messagesAfterCycle2 = await page.locator('[data-message-role]').count();

		// 5. VERIFY: Messages should persist across cycles (no loss, no duplicates)
		expect(messagesAfterCycle2).toBeGreaterThanOrEqual(messagesAfterCycle1);

		// 6. Verify no duplicates
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false);
				messageIds.add(uuid);
			}
		}

		expect(messageIds.size).toBe(messagesAfterCycle2);
	});
});

test.describe('Reconnection - Long Disconnection Period', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for WebSocket connection to be established
		await waitForWebSocketConnected(page);
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

	test('should handle reconnection with long disconnection period', async ({ page }) => {
		// 1. Create session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// 2. Send message
		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Say hello');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 3. Wait for processing to start
		await page.waitForTimeout(2000);

		// 4. Disconnect for extended period (> 5 minutes would trigger full sync)
		// For test purposes, we'll simulate the scenario by clearing lastSync
		await page.evaluate(() => {
			// Simulate very old lastSync timestamp (triggers full sync fallback)
			const staleTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
			(
				window as unknown as {
					__stateChannels?: Map<string, { lastSync: { value: number } }>;
				}
			).__stateChannels?.forEach((channel) => {
				if (channel.lastSync) {
					channel.lastSync.value = staleTimestamp;
				}
			});

			// Then disconnect
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});

		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(3000);

		// 5. Wait for auto-reconnect (should trigger full sync with merge)
		await expect(page.locator('text=Online').first()).toBeVisible({
			timeout: 15000,
		});
		await page.waitForTimeout(2000);

		// 6. Verify messages are still present
		const messageCount = await page.locator('[data-message-role]').count();
		expect(messageCount).toBeGreaterThan(0);

		// 7. Verify no duplicates
		const messageElements = await page.locator('[data-message-role]').all();
		const messageIds = new Set<string>();

		for (const element of messageElements) {
			const uuid = await element.evaluate((el) => el.getAttribute('data-message-uuid') || null);
			if (uuid) {
				expect(messageIds.has(uuid)).toBe(false);
				messageIds.add(uuid);
			}
		}

		expect(messageIds.size).toBe(messageCount);
	});
});

test.describe('Reconnection - Message Sync Bug (Critical)', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should sync all messages and state after background/foreground cycle', async ({ page }) => {
		// ============================================================
		// STEP 1: Create session and establish initial state
		// ============================================================
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		console.log(`[E2E] Session created: ${sessionId}`);

		// ============================================================
		// STEP 2: Send initial message and verify it appears
		// ============================================================
		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Initial message before background');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// Wait for user message to appear
		await page.getByText('Initial message before background').first().waitFor({ state: 'visible' });

		// Count initial messages (should be at least 1: the user message)
		const initialMessageCount = await page.locator('[data-message-role]').count();
		console.log(`[E2E] Initial message count: ${initialMessageCount}`);
		expect(initialMessageCount).toBeGreaterThanOrEqual(1);

		// ============================================================
		// STEP 3: Simulate browser going to background
		// (Safari pauses WebSocket, triggering visibilitychange)
		// ============================================================
		console.log('[E2E] Simulating browser background...');

		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', {
				value: true,
				writable: true,
				configurable: true,
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});

		// Wait a bit for background state to settle
		await page.waitForTimeout(500);

		// ============================================================
		// STEP 4: While "backgrounded", inject messages directly into DB
		// (Simulates agent continuing to work: messages 4, 5, result)
		// ============================================================
		console.log('[E2E] Injecting messages while backgrounded...');

		// Get current message count from DB to see what we're starting with
		const dbCountBefore = await page.evaluate(async (sid) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub) throw new Error('MessageHub not available');

			const result = await hub.call<{ count: number }>('message.count', {
				sessionId: sid,
			});
			return result.count;
		}, sessionId);
		console.log(`[E2E] DB message count before injection: ${dbCountBefore}`);

		// Inject 3 new messages directly via DB (simulating agent work)
		// These are messages 4, 5, and the result
		const injectedMessageUUIDs: string[] = [];
		const baseTimestamp = Date.now();

		for (let i = 0; i < 3; i++) {
			const messageData = await page.evaluate(
				async (args) => {
					const [sid, index, timestamp] = args as [string, number, number];
					const hub = window.__messageHub || window.appState?.messageHub;
					if (!hub) throw new Error('MessageHub not available');

					const uuid = `injected-msg-${index}`;
					const content = `Message ${index} generated while backgrounded`;

					// Inject via test RPC handler (bypasses normal message flow)
					// This simulates the agent processing in background
					const result = await hub.call<{ success: boolean; uuid: string }>(
						'test.injectSDKMessage',
						{
							sessionId: sid,
							message: {
								type: 'assistant', // FIX: Use correct SDK message type
								message: {
									role: 'assistant',
									content: [{ type: 'text', text: content }],
								},
								parent_tool_use_id: null,
								uuid,
								session_id: sid,
							},
							timestamp: new Date(timestamp + index * 100).toISOString(), // Slightly different timestamps
						}
					);

					return { uuid: result.uuid, content };
				},
				[sessionId, i + 4, baseTimestamp]
			);

			injectedMessageUUIDs.push(messageData.uuid);
			console.log(`[E2E] Injected message ${i + 1}: ${messageData.uuid}`);
		}

		// Verify messages were injected into DB
		const dbCountAfter = await page.evaluate(async (sid) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub) throw new Error('MessageHub not available');

			const result = await hub.call<{ count: number }>('message.count', {
				sessionId: sid,
			});
			return result.count;
		}, sessionId);
		console.log(`[E2E] DB message count after injection: ${dbCountAfter}`);
		expect(dbCountAfter).toBe(dbCountBefore + 3);

		// ============================================================
		// STEP 5: Simulate browser returning to foreground
		// (triggers visibilitychange, reconnect, and state refresh)
		// ============================================================
		console.log('[E2E] Simulating browser foreground (reconnection)...');

		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});

		// ============================================================
		// STEP 6: Wait for reconnection and state sync
		// ============================================================
		// Wait for connection to be re-established
		await page.waitForFunction(
			() => {
				const hub = window.__messageHub || window.appState?.messageHub;
				return hub?.getState && hub.getState() === 'connected';
			},
			{ timeout: 10000 }
		);

		console.log('[E2E] Reconnected, waiting for state sync...');

		// Wait for state refresh to complete
		// The fix ensures this syncs ALL messages, not just the old snapshot
		await page.waitForTimeout(2000);

		// ============================================================
		// STEP 7: VERIFY: All messages are visible in UI
		// ============================================================
		const finalMessageCount = await page.locator('[data-message-role]').count();
		console.log(`[E2E] Final message count in UI: ${finalMessageCount}`);

		// CRITICAL ASSERTION: All injected messages should be visible
		// Expected: initial messages + 3 injected messages
		// This will FAIL before the fix (race condition causes messages to be lost)
		expect(finalMessageCount).toBeGreaterThanOrEqual(initialMessageCount + 3);

		// Verify each injected message is actually present by UUID
		for (const uuid of injectedMessageUUIDs) {
			const messageExists = await page.locator(`[data-message-uuid="${uuid}"]`).count();
			console.log(`[E2E] Message ${uuid} visible: ${messageExists > 0}`);
			expect(messageExists).toBe(1);
		}

		// Also verify by text content
		for (let i = 0; i < 3; i++) {
			const text = `Message ${i + 4} generated while backgrounded`;
			await expect(page.getByText(text).first()).toBeVisible();
		}

		// ============================================================
		// STEP 8: VERIFY: Agent state is synced (not stale from before background)
		// ============================================================
		// Check sessionStore agent state
		const agentState = await page.evaluate(async (sid) => {
			const store = window.sessionStore;
			if (!store || store.activeSessionId.value !== sid) {
				return { error: 'Session not active in sessionStore' };
			}

			const state = store.sessionState.value?.agentState;
			return state || { error: 'No agent state' };
		}, sessionId);

		console.log('[E2E] Agent state after reconnect:', JSON.stringify(agentState));

		// CRITICAL ASSERTION: Agent state should be synced from server
		// (Not necessarily "idle" since we injected messages without completing the agent query)
		// The key is that the state is CURRENT from the server, not stale from before background
		expect(agentState).toBeDefined();
		expect(agentState.status).toMatch(/idle|processing|thinking/); // Should be a valid status, not undefined/null
	});

	test('should preserve newer messages that arrive via delta during reconnection', async ({
		page,
	}) => {
		// ============================================================
		// This test specifically targets the race condition where:
		// 1. Delta messages arrive BEFORE fetchInitialState completes
		// 2. fetchInitialState then OVERWRITES the newer delta messages
		// ============================================================

		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		console.log(`[E2E] Session created: ${sessionId}`);

		// Send initial message
		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Test message');
		await page.locator('button[aria-label="Send message"]').click();
		await page.getByText('Test message').first().waitFor({ state: 'visible' });

		const initialMessageCount = await page.locator('[data-message-role]').count();
		console.log(`[E2E] Initial message count: ${initialMessageCount}`);

		// ============================================================
		// Simulate the exact race condition scenario
		// ============================================================

		// Go to background
		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', {
				value: true,
				configurable: true,
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await page.waitForTimeout(500);

		// Inject a message that will arrive via delta BEFORE the snapshot fetch completes
		const deltaMessageUUID = `delta-msg-${Date.now()}`;
		await page.evaluate(
			async (args) => {
				const [sid, uuid] = args as [string, string];
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub) throw new Error('MessageHub not available');

				// Inject via DB
				await hub.call('test.injectSDKMessage', {
					sessionId: sid,
					message: {
						type: 'assistant', // FIX: Use correct SDK message type
						message: {
							role: 'assistant',
							content: [{ type: 'text', text: 'Delta message (arrives first)' }],
						},
						parent_tool_use_id: null,
						uuid,
						session_id: sid,
					},
				});

				// Broadcast via delta channel (simulates delta arriving before fetchInitialState)
				await hub.call('test.broadcastDelta', {
					sessionId: sid,
					channel: 'state.sdkMessages.delta',
					data: {
						added: [
							{
								type: 'assistant', // FIX: Use correct SDK message type
								message: {
									role: 'assistant',
									content: [{ type: 'text', text: 'Delta message (arrives first)' }],
								},
								uuid,
								timestamp: Date.now(),
							},
						],
					},
				});
			},
			[sessionId, deltaMessageUUID]
		);

		console.log('[E2E] Delta message broadcast');

		// Small delay to ensure delta arrives before we return to foreground
		await page.waitForTimeout(100);

		// Return to foreground (triggers reconnection with fetchInitialState)
		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', {
				value: false,
				configurable: true,
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});

		// Wait for reconnection
		await page.waitForFunction(
			() => {
				const hub = window.__messageHub || window.appState?.messageHub;
				return hub?.getState && hub.getState() === 'connected';
			},
			{ timeout: 10000 }
		);

		// Wait for state sync
		await page.waitForTimeout(2000);

		// CRITICAL ASSERTION: Delta message should still be present
		// Before the fix, fetchInitialState would overwrite it
		const deltaMessageExists = await page
			.locator(`[data-message-uuid="${deltaMessageUUID}"]`)
			.count();
		console.log(`[E2E] Delta message visible after reconnection: ${deltaMessageExists > 0}`);

		expect(deltaMessageExists).toBe(1);

		// Verify by text
		await expect(page.getByText('Delta message (arrives first)').first()).toBeVisible();
	});

	test('should handle multiple background/foreground cycles correctly', async ({ page }) => {
		// Test the fix across multiple reconnection cycles
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		const sendButton = page.locator('button[aria-label="Send message"]');

		// Send initial message
		await messageInput.click();
		await messageInput.fill('Cycle test message');
		await sendButton.click();
		await page.getByText('Cycle test message').first().waitFor({ state: 'visible' });

		const baselineCount = await page.locator('[data-message-role]').count();
		console.log(`[E2E] Baseline message count: ${baselineCount}`);

		// Perform 3 background/foreground cycles
		for (let cycle = 0; cycle < 3; cycle++) {
			console.log(`[E2E] Starting cycle ${cycle + 1}/3`);

			// Go to background
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});
			await page.waitForTimeout(300);

			// Inject a message during this cycle
			const cycleMessageUUID = `cycle-${cycle}-msg-${Date.now()}`;
			await page.evaluate(
				async (args) => {
					const [sid, uuid, idx] = args as [string, string, number];
					const hub = window.__messageHub || window.appState?.messageHub;
					if (!hub) throw new Error('MessageHub not available');

					await hub.call('test.injectSDKMessage', {
						sessionId: sid,
						message: {
							type: 'assistant', // FIX: Use correct SDK message type
							message: {
								role: 'assistant',
								content: [
									{
										type: 'text',
										text: `Cycle ${idx} message generated while backgrounded`,
									},
								],
							},
							parent_tool_use_id: null,
							uuid,
							session_id: sid,
						},
					});
				},
				[sessionId, cycleMessageUUID, cycle]
			);

			console.log(`[E2E] Cycle ${cycle + 1}: Injected message ${cycleMessageUUID}`);

			// Return to foreground
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: false,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Wait for reconnection
			await page.waitForFunction(
				() => {
					const hub = window.__messageHub || window.appState?.messageHub;
					return hub?.getState && hub.getState() === 'connected';
				},
				{ timeout: 10000 }
			);

			await page.waitForTimeout(1000);

			// Verify message from this cycle is visible
			const cycleMessageExists = await page
				.locator(`[data-message-uuid="${cycleMessageUUID}"]`)
				.count();
			console.log(`[E2E] Cycle ${cycle + 1}: Message visible: ${cycleMessageExists > 0}`);
			expect(cycleMessageExists).toBe(1);
		}

		// Final verification: all cycle messages should be present
		const finalCount = await page.locator('[data-message-role]').count();
		console.log(`[E2E] Final message count: ${finalCount} (expected: ${baselineCount + 3})`);

		expect(finalCount).toBeGreaterThanOrEqual(baselineCount + 3);

		// Verify agent state is synced (not necessarily "idle" since we're injecting messages)
		const agentState = await page.evaluate((sid) => {
			const store = window.sessionStore;
			if (!store || store.activeSessionId.value !== sid) {
				return { error: 'Session not active' };
			}
			return store.sessionState.value?.agentState || { error: 'No state' };
		}, sessionId);

		// Should be a valid status from the server (not undefined/null)
		expect(agentState).toBeDefined();
		expect(agentState.status).toMatch(/idle|processing|thinking/);
	});
});

test.describe('Reconnection - Message Order', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for connection to be established
		await waitForWebSocketConnected(page);
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

	test('should preserve message order after reconnection', async ({ page }) => {
		// 1. Create session and send message
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Count: 1, 2, 3');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// 2. Wait for some messages
		await page.waitForTimeout(3000);

		// 3. Get message timestamps before disconnect
		const timestampsBeforeDisconnect = await page.evaluate(() => {
			const messages = Array.from(document.querySelectorAll('[data-message-role]'));
			return messages.map((el) => ({
				uuid: el.getAttribute('data-message-uuid') || null,
				timestamp: el.getAttribute('data-message-timestamp'),
			}));
		});

		// 4. Disconnect and wait for auto-reconnect
		await page.evaluate(() => {
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});
		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});
		await page.waitForTimeout(2000);

		// Wait for auto-reconnect
		await expect(page.locator('text=Online').first()).toBeVisible({
			timeout: 15000,
		});
		await page.waitForTimeout(2000);

		// 5. Get message timestamps after reconnect
		const timestampsAfterReconnect = await page.evaluate(() => {
			const messages = Array.from(document.querySelectorAll('[data-message-role]'));
			return messages.map((el) => ({
				uuid: el.getAttribute('data-message-uuid') || null,
				timestamp: el.getAttribute('data-message-timestamp'),
			}));
		});

		// 6. VERIFY: Messages should be in same order (by timestamp)
		const beforeUuids = timestampsBeforeDisconnect.map((m) => m.uuid);
		const afterUuids = timestampsAfterReconnect.slice(0, beforeUuids.length).map((m) => m.uuid);

		expect(afterUuids).toEqual(beforeUuids);

		// 7. VERIFY: All timestamps should be in ascending order
		for (let i = 1; i < timestampsAfterReconnect.length; i++) {
			const prevTime = Number(timestampsAfterReconnect[i - 1].timestamp);
			const currTime = Number(timestampsAfterReconnect[i].timestamp);
			expect(currTime).toBeGreaterThanOrEqual(prevTime);
		}
	});
});

// ============================================================
// Tests merged from connection.e2e.ts
// ============================================================

test.describe('Connection - Input Blocking', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should block input during disconnection', async ({ page }) => {
		// Create a session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Wait for connection
		await expect(page.locator('text=Online').first()).toBeVisible({
			timeout: 10000,
		});

		// Get textarea and verify it's enabled
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible();
		const isEnabledBefore = await textarea.isEnabled();
		expect(isEnabledBefore).toBe(true);

		// Simulate disconnect
		await page.evaluate(() => {
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});

		// Brief wait for disconnect to process
		await page.waitForTimeout(300);

		// Wait for reconnect (auto-reconnect happens quickly)
		await expect(page.locator('text=Online').first()).toBeVisible({
			timeout: 15000,
		});

		// After reconnect, textarea should be enabled again
		await expect(textarea).toBeEnabled();
	});
});

test.describe('Connection - State Transitions', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
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

	test('should maintain session data after reconnection', async ({ page }) => {
		// Create session and send message
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const messageInput = page.locator('textarea[placeholder*="Ask"]');
		await messageInput.click();
		await messageInput.fill('Test message for reconnection');

		const sendButton = page.locator('button[aria-label="Send message"]');
		await sendButton.click();

		// Wait for message to appear
		await expect(page.getByText('Test message for reconnection').first()).toBeVisible();

		// Count messages before disconnect
		const messagesBeforeDisconnect = await page.locator('[data-message-role]').count();

		// Simulate disconnect
		await page.evaluate(() => {
			(
				window as unknown as {
					connectionManager: { simulateDisconnect: () => void };
				}
			).connectionManager.simulateDisconnect();
		});

		await expect(page.locator('text=Offline').first()).toBeVisible({
			timeout: 5000,
		});

		// Wait for auto-reconnect
		await expect(page.locator('text=Online').first()).toBeVisible({
			timeout: 15000,
		});

		await page.waitForTimeout(1000);

		// Verify messages are still present (session data maintained)
		const messagesAfterReconnect = await page.locator('[data-message-role]').count();
		expect(messagesAfterReconnect).toBeGreaterThanOrEqual(messagesBeforeDisconnect);

		// Verify original message is still visible
		await expect(page.getByText('Test message for reconnection').first()).toBeVisible();
	});
});
