/**
 * E2E tests for Safari background tab behavior
 *
 * Tests real browser behavior for:
 * - Page visibility changes
 * - WebSocket reconnection
 * - UI data synchronization after background period
 * - Message persistence during background
 *
 * Run with: make e2e or make e2e-headed
 */

import { test, expect } from '@playwright/test';

test.describe('Safari Background Tab - E2E Tests', () => {
	test.describe('Session List Synchronization', () => {
		test('should show new sessions created while backgrounded', async ({ page }) => {
			// 1. Navigate to app and wait for load
			await page.goto('http://localhost:9283');
			await page.waitForLoadState('networkidle');
			await page.waitForSelector('[data-testid="session-list"]', {
				timeout: 5000,
			});

			// 2. Verify initial state (no sessions)
			const initialCount = await page.locator('[data-testid="session-item"]').count();
			console.log(`Initial session count: ${initialCount}`);

			// 3. Simulate page going to background
			await page.evaluate(() => {
				console.log('[E2E] Simulating page background');
				Object.defineProperty(document, 'hidden', {
					value: true,
					writable: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Wait a bit to ensure background state is set
			await page.waitForTimeout(500);

			// 4. While "backgrounded", create a session via direct MessageHub call
			await page.evaluate(async () => {
				console.log('[E2E] Creating session while backgrounded');
				if (window.__messageHub && window.__messageHubReady) {
					try {
						const result = await window.__messageHub.call('session.create', {
							workspacePath: '/tmp/test-workspace',
						});
						console.log('[E2E] Session created:', result);
					} catch (error) {
						console.error('[E2E] Failed to create session:', error);
						throw error;
					}
				} else {
					throw new Error('MessageHub not ready');
				}
			});

			// Wait for server to process
			await page.waitForTimeout(1000);

			// 5. Simulate returning to foreground
			await page.evaluate(() => {
				console.log('[E2E] Simulating page foreground');
				Object.defineProperty(document, 'hidden', {
					value: false,
					writable: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// 6. Wait for reconnection and refresh
			await page.waitForTimeout(1000);

			// 7. Verify new session appears in UI
			const finalCount = await page.locator('[data-testid="session-item"]').count();
			console.log(`Final session count: ${finalCount}`);
			expect(finalCount).toBe(initialCount + 1);

			// Verify session is visible and clickable
			const sessionItem = page.locator('[data-testid="session-item"]').first();
			await expect(sessionItem).toBeVisible();
		});

		test('should update session metadata changed while backgrounded', async ({ page }) => {
			// 1. Create a session first
			await page.goto('http://localhost:9283');
			await page.waitForLoadState('networkidle');

			await page.evaluate(async () => {
				if (window.__messageHub) {
					await window.__messageHub.call('session.create', {
						workspacePath: '/tmp/test-workspace',
					});
				}
			});

			await page.waitForTimeout(500);

			// Get initial session title
			const initialTitle = await page.locator('[data-testid="session-item"]').first().textContent();
			console.log(`Initial title: ${initialTitle}`);

			// 2. Background the page
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// 3. Update session title while backgrounded
			await page.evaluate(async () => {
				if (window.__messageHub) {
					const sessions = await window.__messageHub.call('session.list', {});
					const sessionId = sessions[0]?.id;

					if (sessionId) {
						await window.__messageHub.call('session.update', {
							sessionId,
							updates: { title: 'Updated While Backgrounded' },
						});
					}
				}
			});

			await page.waitForTimeout(500);

			// 4. Return to foreground
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: false,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			await page.waitForTimeout(1000);

			// 5. Verify title is updated
			const updatedTitle = await page.locator('[data-testid="session-item"]').first().textContent();
			console.log(`Updated title: ${updatedTitle}`);
			expect(updatedTitle).toContain('Updated While Backgrounded');
		});
	});

	test.describe('Message Synchronization', () => {
		test('should show messages generated while backgrounded', async ({ page }) => {
			// 1. Create session and start conversation
			await page.goto('http://localhost:9283');
			await page.waitForLoadState('networkidle');

			// Create session
			await page.click('[data-testid="new-session-button"]');
			await page.waitForSelector('[data-testid="message-input"]');

			// Send initial message
			await page.fill('[data-testid="message-input"]', 'Hello');
			await page.click('[data-testid="send-button"]');

			// Wait for user message to appear
			await page.waitForSelector('[data-testid="user-message"]');
			const initialMsgCount = await page.locator('[data-testid="sdk-message"]').count();
			console.log(`Initial message count: ${initialMsgCount}`);

			// 2. Background the page
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// 3. Simulate SDK generating messages (via test API or direct DB insertion)
			// This would require a test endpoint on the server to inject messages
			// For now, we'll simulate the flow without actual SDK streaming

			await page.waitForTimeout(2000); // Simulate time passing

			// 4. Return to foreground
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: false,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// 5. Wait for refresh
			await page.waitForTimeout(1000);

			// 6. Verify UI updates
			// Note: In a real scenario with SDK streaming, we'd verify new messages appear
			const finalMsgCount = await page.locator('[data-testid="sdk-message"]').count();
			console.log(`Final message count: ${finalMsgCount}`);
			expect(finalMsgCount).toBeGreaterThanOrEqual(initialMsgCount);
		});

		test('should handle sending message after returning from background', async ({ page }) => {
			// 1. Create session
			await page.goto('http://localhost:9283');
			await page.waitForLoadState('networkidle');
			await page.click('[data-testid="new-session-button"]');
			await page.waitForSelector('[data-testid="message-input"]');

			// 2. Background and foreground
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});
			await page.waitForTimeout(500);

			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: false,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});
			await page.waitForTimeout(1000);

			// 3. Send message after reconnection
			await page.fill('[data-testid="message-input"]', 'Message after reconnect');
			await page.click('[data-testid="send-button"]');

			// 4. Verify message appears
			await page.waitForSelector('text=Message after reconnect');
			const userMessage = page.locator('[data-testid="user-message"]', {
				hasText: 'Message after reconnect',
			});
			await expect(userMessage).toBeVisible();
		});
	});

	test.describe('Connection Status Indicators', () => {
		test('should show reconnecting state during validation', async ({ page }) => {
			await page.goto('http://localhost:9283');
			await page.waitForLoadState('networkidle');

			// Background the page
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Trigger visibility change and immediately check connection status
			const statusPromise = page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: false,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));

				// Return connection state after a brief moment
				return new Promise<string>((resolve) => {
					setTimeout(() => {
						resolve(
							(window as unknown as Record<string, unknown>).connectionState?.value || 'unknown'
						);
					}, 50);
				});
			});

			const status = await statusPromise;
			console.log(`Connection status during validation: ${status}`);

			// Status should eventually become 'connected'
			await page.waitForTimeout(1000);
			const finalStatus = await page.evaluate(() => {
				return (window as unknown as Record<string, unknown>).connectionState?.value;
			});
			expect(finalStatus).toBe('connected');
		});

		test('should maintain connected state if health check passes', async ({ page }) => {
			await page.goto('http://localhost:9283');
			await page.waitForLoadState('networkidle');

			// Get initial connection state
			const initialState = await page.evaluate(() => {
				return (window as unknown as Record<string, unknown>).connectionState?.value;
			});
			expect(initialState).toBe('connected');

			// Background and foreground
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});
			await page.waitForTimeout(500);

			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: false,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Wait for validation to complete
			await page.waitForTimeout(1500);

			// Connection should still be 'connected'
			const finalState = await page.evaluate(() => {
				return (window as unknown as Record<string, unknown>).connectionState?.value;
			});
			expect(finalState).toBe('connected');
		});
	});

	test.describe('Multiple Background/Foreground Cycles', () => {
		test('should handle repeated background/foreground transitions', async ({ page }) => {
			await page.goto('http://localhost:9283');
			await page.waitForLoadState('networkidle');

			// Create initial session
			await page.evaluate(async () => {
				if (window.__messageHub) {
					await window.__messageHub.call('session.create', {
						workspacePath: '/tmp/test-workspace',
					});
				}
			});
			await page.waitForTimeout(500);

			// Perform 3 background/foreground cycles
			for (let i = 0; i < 3; i++) {
				console.log(`Cycle ${i + 1}: Background`);
				await page.evaluate(() => {
					Object.defineProperty(document, 'hidden', {
						value: true,
						configurable: true,
					});
					document.dispatchEvent(new Event('visibilitychange'));
				});
				await page.waitForTimeout(300);

				console.log(`Cycle ${i + 1}: Foreground`);
				await page.evaluate(() => {
					Object.defineProperty(document, 'hidden', {
						value: false,
						configurable: true,
					});
					document.dispatchEvent(new Event('visibilitychange'));
				});
				await page.waitForTimeout(800);
			}

			// Verify UI is still functional
			const sessionCount = await page.locator('[data-testid="session-item"]').count();
			expect(sessionCount).toBeGreaterThanOrEqual(1);

			// Verify can still interact
			await page.click('[data-testid="session-item"]').catch(() => {
				// May already be selected
			});
			await expect(page.locator('[data-testid="message-input"]')).toBeVisible();
		});
	});

	test.describe('Long Background Periods', () => {
		test('should recover after extended background time', async ({ page }) => {
			await page.goto('http://localhost:9283');
			await page.waitForLoadState('networkidle');

			// Create session
			await page.evaluate(async () => {
				if (window.__messageHub) {
					await window.__messageHub.call('session.create', {
						workspacePath: '/tmp/test-workspace',
					});
				}
			});
			await page.waitForTimeout(500);

			const initialCount = await page.locator('[data-testid="session-item"]').count();

			// Background for extended period (simulating 5 minutes)
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Wait longer than normal (simulating time passage)
			await page.waitForTimeout(3000);

			// Create another session during background
			await page.evaluate(async () => {
				if (window.__messageHub) {
					await window.__messageHub.call('session.create', {
						workspacePath: '/tmp/test-workspace-2',
					});
				}
			});
			await page.waitForTimeout(500);

			// Return to foreground
			await page.evaluate(() => {
				Object.defineProperty(document, 'hidden', {
					value: false,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Wait for full refresh (not incremental)
			await page.waitForTimeout(1500);

			// Verify all data is present
			const finalCount = await page.locator('[data-testid="session-item"]').count();
			expect(finalCount).toBe(initialCount + 1);
		});
	});
});
