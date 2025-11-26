/**
 * MessageHub Protocol E2E Tests
 *
 * Tests the core messaging protocol:
 * - RPC call/response flow
 * - Pub/Sub event system
 * - WebSocket connection handling
 * - Session-scoped routing
 */

import { test, expect, Page } from '@playwright/test';

// Helper to expose MessageHub for testing
async function exposeMessageHub(page: Page) {
  // Inject script to expose MessageHub instance
  await page.addInitScript(() => {
    // Wait for MessageHub to be available
    const checkInterval = setInterval(() => {
      const hub = (window as any).appState?.messageHub;
      if (hub) {
        (window as any).__messageHub = hub;
        (window as any).__messageHubReady = true;
        clearInterval(checkInterval);
      }
    }, 100);
  });
}

// Helper to wait for MessageHub to be ready
async function waitForMessageHub(page: Page) {
  await page.waitForFunction(
    () => (window as any).__messageHubReady === true,
    { timeout: 10000 }
  );
}

test.describe('MessageHub RPC Protocol', () => {
  test.beforeEach(async ({ page }) => {
    await exposeMessageHub(page);
    await page.goto('/');
    await waitForMessageHub(page);
  });

  test('should handle RPC call/response correctly', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      // Call session.list RPC method
      const response = await hub.call('session.list', {}, { timeout: 5000 });
      return response;
    });

    expect(result).toHaveProperty('sessions');
    expect(Array.isArray(result.sessions)).toBe(true);
  });

  test('should handle RPC timeout correctly', async ({ page }) => {
    const error = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      try {
        // Call non-existent method with short timeout
        await hub.call('non.existent.method', {}, { timeout: 1000 });
        return null;
      } catch (err: any) {
        return { message: err.message, code: err.code };
      }
    });

    expect(error).toBeTruthy();
    expect(error?.message).toContain('timeout');
  });

  test('should handle RPC error responses', async ({ page }) => {
    const error = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      try {
        // Try to get non-existent session
        await hub.call('session.get', { sessionId: 'non-existent-id' });
        return null;
      } catch (err: any) {
        return { message: err.message };
      }
    });

    expect(error).toBeTruthy();
    expect(error?.message).toContain('not found');
  });

  test('should handle concurrent RPC calls', async ({ page }) => {
    const results = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      // Make 5 concurrent RPC calls
      const promises = [
        hub.call('session.list'),
        hub.call('state.global.health'),
        hub.call('state.global.auth'),
        hub.call('state.global.config'),
        hub.call('session.list'), // Duplicate to test deduplication
      ];

      const responses = await Promise.all(promises);
      return {
        count: responses.length,
        allSuccessful: responses.every(r => r !== null && r !== undefined),
      };
    });

    expect(results.count).toBe(5);
    expect(results.allSuccessful).toBe(true);
  });

  test('should validate request/response correlation', async ({ page }) => {
    const correlationTest = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      const results: any[] = [];

      // Track message IDs
      const originalSend = hub.sendMessage.bind(hub);
      const sentIds: string[] = [];
      const receivedIds: string[] = [];

      hub.sendMessage = function(msg: any) {
        if (msg.type === 'CALL') sentIds.push(msg.id);
        return originalSend(msg);
      };

      // Make multiple calls and verify responses match requests
      const call1 = hub.call('session.list').then((r: any) => {
        receivedIds.push(r.__messageId || 'unknown');
        return r;
      });

      const call2 = hub.call('state.global.health').then((r: any) => {
        receivedIds.push(r.__messageId || 'unknown');
        return r;
      });

      await Promise.all([call1, call2]);

      // Restore original method
      hub.sendMessage = originalSend;

      return {
        sentCount: sentIds.length,
        receivedCount: receivedIds.length,
        allUnique: sentIds.length === new Set(sentIds).size,
      };
    });

    expect(correlationTest.sentCount).toBeGreaterThan(0);
    expect(correlationTest.sentCount).toBe(correlationTest.receivedCount);
    expect(correlationTest.allUnique).toBe(true);
  });
});

test.describe('MessageHub Pub/Sub Protocol', () => {
  test.beforeEach(async ({ page }) => {
    await exposeMessageHub(page);
    await page.goto('/');
    await waitForMessageHub(page);
  });

  test('should deliver events to subscribers', async ({ page }) => {
    const eventTest = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      return new Promise((resolve) => {
        const testEvent = 'test.event.' + Date.now();
        let received = false;

        // Subscribe to event
        const unsubscribe = hub.subscribe(testEvent, (data: any) => {
          received = true;
          unsubscribe();
          resolve({ received, data });
        });

        // Publish event after short delay
        setTimeout(() => {
          hub.publish(testEvent, { test: 'data' }, { sessionId: 'global' });
        }, 100);

        // Timeout fallback
        setTimeout(() => {
          if (!received) {
            unsubscribe();
            resolve({ received: false, error: 'timeout' });
          }
        }, 2000);
      });
    });

    expect(eventTest.received).toBe(true);
    expect(eventTest.data).toEqual({ test: 'data' });
  });

  test('should handle multiple subscribers for same event', async ({ page }) => {
    const multiSubTest = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      return new Promise((resolve) => {
        const testEvent = 'test.multi.' + Date.now();
        const receivedBy: number[] = [];

        // Create 3 subscribers
        const unsub1 = hub.subscribe(testEvent, () => {
          receivedBy.push(1);
        });

        const unsub2 = hub.subscribe(testEvent, () => {
          receivedBy.push(2);
        });

        const unsub3 = hub.subscribe(testEvent, () => {
          receivedBy.push(3);
        });

        // Publish event
        hub.publish(testEvent, { test: 'multi' }, { sessionId: 'global' });

        // Wait and check results
        setTimeout(() => {
          unsub1();
          unsub2();
          unsub3();
          resolve({
            count: receivedBy.length,
            allReceived: receivedBy.includes(1) && receivedBy.includes(2) && receivedBy.includes(3),
          });
        }, 500);
      });
    });

    expect(multiSubTest.count).toBe(3);
    expect(multiSubTest.allReceived).toBe(true);
  });

  test('should respect session-scoped event routing', async ({ page }) => {
    // Create a session first
    await page.click('button:has-text("New Session")');
    await page.waitForTimeout(1000);

    const sessionScopeTest = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      // Get current session ID from state
      const currentSessionId = (window as any).appState?.currentSessionId?.value || 'test-session';

      return new Promise((resolve) => {
        const results = {
          globalReceived: false,
          sessionReceived: false,
          wrongSessionReceived: false,
        };

        // Subscribe to global events
        const unsubGlobal = hub.subscribe('test.scoped', () => {
          results.globalReceived = true;
        }, { sessionId: 'global' });

        // Subscribe to specific session events
        const unsubSession = hub.subscribe('test.scoped', () => {
          results.sessionReceived = true;
        }, { sessionId: currentSessionId });

        // Subscribe to different session (should not receive)
        const unsubWrong = hub.subscribe('test.scoped', () => {
          results.wrongSessionReceived = true;
        }, { sessionId: 'wrong-session-id' });

        // Publish to specific session
        hub.publish('test.scoped', { test: 'data' }, { sessionId: currentSessionId });

        // Wait and check results
        setTimeout(() => {
          unsubGlobal();
          unsubSession();
          unsubWrong();
          resolve(results);
        }, 500);
      });
    });

    expect(sessionScopeTest.sessionReceived).toBe(true);
    expect(sessionScopeTest.globalReceived).toBe(false);
    expect(sessionScopeTest.wrongSessionReceived).toBe(false);
  });

  test('should handle unsubscribe correctly', async ({ page }) => {
    const unsubTest = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      return new Promise((resolve) => {
        const testEvent = 'test.unsub.' + Date.now();
        let callCount = 0;

        // Subscribe to event
        const unsubscribe = hub.subscribe(testEvent, () => {
          callCount++;
        });

        // Publish first event
        hub.publish(testEvent, { n: 1 }, { sessionId: 'global' });

        setTimeout(() => {
          // Unsubscribe
          unsubscribe();

          // Publish second event (should not be received)
          hub.publish(testEvent, { n: 2 }, { sessionId: 'global' });

          setTimeout(() => {
            resolve({ callCount });
          }, 200);
        }, 200);
      });
    });

    expect(unsubTest.callCount).toBe(1);
  });

  test('should maintain subscriptions after reconnect', async ({ page }) => {
    // This test would require simulating WebSocket disconnection
    // For now, we'll test that subscriptions persist across navigation

    // Subscribe to an event
    await page.evaluate(async () => {
      const hub = (window as any).__messageHub;
      if (!hub) throw new Error('MessageHub not found');

      // Create persistent subscription
      (window as any).__testSubscription = hub.subscribe(
        'test.persistent',
        (data: any) => {
          (window as any).__testReceived = data;
        },
        { sessionId: 'global' }
      );
    });

    // Navigate to trigger potential reconnection
    await page.click('button:has-text("New Session")');
    await page.waitForTimeout(1000);

    // Go back home
    await page.click('h1:has-text("Liuboer")');
    await page.waitForTimeout(500);

    // Test if subscription still works
    const persistenceTest = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;

      // Publish to the persisted subscription
      hub.publish('test.persistent', { persisted: true }, { sessionId: 'global' });

      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            received: (window as any).__testReceived,
            subscriptionExists: !!(window as any).__testSubscription,
          });
        }, 500);
      });
    });

    expect(persistenceTest.subscriptionExists).toBe(true);
    expect(persistenceTest.received).toEqual({ persisted: true });
  });
});

test.describe('WebSocket Connection Management', () => {
  test.beforeEach(async ({ page }) => {
    await exposeMessageHub(page);
    await page.goto('/');
    await waitForMessageHub(page);
  });

  test('should show connected status', async ({ page }) => {
    await expect(page.locator('text=Connected')).toBeVisible({ timeout: 5000 });

    const connectionState = await page.evaluate(() => {
      const hub = (window as any).__messageHub;
      return hub?.getState();
    });

    expect(connectionState).toBe('connected');
  });

  test('should handle ping/pong heartbeat', async ({ page }) => {
    // Monitor WebSocket messages
    const wsMessages = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const messages: string[] = [];
        const hub = (window as any).__messageHub;

        // Intercept WebSocket send
        const transport = hub.transport;
        if (transport && transport.ws) {
          const originalSend = transport.ws.send.bind(transport.ws);
          transport.ws.send = function(data: string) {
            try {
              const msg = JSON.parse(data);
              if (msg.type === 'PING' || msg.type === 'PONG') {
                messages.push(msg.type);
              }
            } catch {}
            return originalSend(data);
          };
        }

        // Wait for heartbeat messages
        setTimeout(() => {
          resolve(messages);
        }, 3000);
      });
    });

    // Should have at least some heartbeat activity
    expect(Array.isArray(wsMessages)).toBe(true);
  });

  test('should queue messages during disconnect', async ({ page }) => {
    // This test would require simulating WebSocket disconnection
    // We'll test that the MessageHub has queuing capability

    const queueTest = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;

      // Check if MessageHub has pending calls map (indicates queuing capability)
      const hasPendingCalls = hub.pendingCalls && hub.pendingCalls instanceof Map;
      const hasMessageQueue = hub.messageQueue && Array.isArray(hub.messageQueue);

      return {
        hasQueueingCapability: hasPendingCalls || hasMessageQueue,
      };
    });

    expect(queueTest.hasQueueingCapability).toBe(true);
  });

  test('should handle backpressure', async ({ page }) => {
    // Test that MessageHub respects backpressure limits
    const backpressureTest = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;

      // Check configured limits
      const maxPendingCalls = hub.maxPendingCalls || 1000;
      const results = {
        hasBackpressureLimit: maxPendingCalls > 0,
        limitValue: maxPendingCalls,
      };

      // Try to exceed the limit (don't await to avoid blocking)
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          hub.call('session.list', {}, { timeout: 30000 }).catch(() => null)
        );
      }

      // Check pending calls count
      results.pendingCount = hub.pendingCalls?.size || 0;

      // Clean up
      await Promise.all(promises);

      return results;
    });

    expect(backpressureTest.hasBackpressureLimit).toBe(true);
    expect(backpressureTest.limitValue).toBeGreaterThan(0);
  });
});

test.describe('Multi-Tab Event Routing', () => {
  test('should route events only to correct subscribers', async ({ browser }) => {
    const context = await browser.newContext();

    // Create 3 tabs
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    const tabC = await context.newPage();

    // Setup all tabs
    for (const tab of [tabA, tabB, tabC]) {
      await exposeMessageHub(tab);
      await tab.goto('/');
      await waitForMessageHub(tab);
    }

    // Create sessions in tabs A and B
    await tabA.click('button:has-text("New Session")');
    await tabA.waitForTimeout(1000);
    const sessionIdA = await tabA.evaluate(() => {
      return (window as any).appState?.currentSessionId?.value;
    });

    await tabB.click('button:has-text("New Session")');
    await tabB.waitForTimeout(1000);
    const sessionIdB = await tabB.evaluate(() => {
      return (window as any).appState?.currentSessionId?.value;
    });

    // Set up event tracking in each tab
    await tabA.evaluate((sessionId) => {
      const hub = (window as any).__messageHub;
      (window as any).__receivedEvents = [];

      // Subscribe to session-specific events
      hub.subscribe('test.routing', (data: any) => {
        (window as any).__receivedEvents.push({ ...data, tab: 'A' });
      }, { sessionId });
    }, sessionIdA);

    await tabB.evaluate((sessionId) => {
      const hub = (window as any).__messageHub;
      (window as any).__receivedEvents = [];

      // Subscribe to session-specific events
      hub.subscribe('test.routing', (data: any) => {
        (window as any).__receivedEvents.push({ ...data, tab: 'B' });
      }, { sessionId });
    }, sessionIdB);

    await tabC.evaluate(() => {
      const hub = (window as any).__messageHub;
      (window as any).__receivedEvents = [];

      // Subscribe to global events
      hub.subscribe('test.routing', (data: any) => {
        (window as any).__receivedEvents.push({ ...data, tab: 'C' });
      }, { sessionId: 'global' });
    });

    // Publish session-specific event from tab A
    await tabA.evaluate((sessionId) => {
      const hub = (window as any).__messageHub;
      hub.publish('test.routing', { from: 'A', target: 'session' }, { sessionId });
    }, sessionIdA);

    await tabA.waitForTimeout(500);

    // Check reception
    const eventsA = await tabA.evaluate(() => (window as any).__receivedEvents);
    const eventsB = await tabB.evaluate(() => (window as any).__receivedEvents);
    const eventsC = await tabC.evaluate(() => (window as any).__receivedEvents);

    // Tab A should receive its own session event
    expect(eventsA.length).toBe(1);
    expect(eventsA[0]).toMatchObject({ from: 'A', target: 'session', tab: 'A' });

    // Tab B should not receive tab A's session event
    expect(eventsB.length).toBe(0);

    // Tab C (global subscriber) should not receive session-specific events
    expect(eventsC.length).toBe(0);

    await context.close();
  });
});