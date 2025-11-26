/**
 * Event-based wait helpers to replace arbitrary timeouts
 *
 * These helpers wait for specific conditions or events instead of fixed timeouts,
 * making tests more reliable and faster.
 */

import { Page, Locator } from '@playwright/test';

/**
 * Wait for WebSocket connection to be established
 */
export async function waitForWebSocketConnected(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
      return hub?.getState && hub.getState() === 'connected';
    },
    { timeout: 10000 }
  );

  // Also wait for visual indicator
  await page.locator('text=Connected').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Wait for session to be created and loaded
 */
export async function waitForSessionCreated(page: Page): Promise<string> {
  // Wait for navigation away from home
  await page.waitForFunction(
    () => !document.querySelector('h2')?.textContent?.includes('Welcome to Liuboer'),
    { timeout: 10000 }
  );

  // Wait for message input to be visible and enabled
  const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
  await messageInput.waitFor({ state: 'visible', timeout: 10000 });
  await messageInput.waitFor({ state: 'enabled', timeout: 5000 });

  // Get and return the session ID
  const sessionId = await page.evaluate(() => {
    return (window as any).appState?.currentSessionId?.value ||
           window.location.pathname.split('/').filter(Boolean)[0];
  });

  if (!sessionId) {
    throw new Error('Session ID not found after creation');
  }

  return sessionId;
}

/**
 * Wait for session to be deleted and UI to update
 */
export async function waitForSessionDeleted(page: Page, sessionId: string): Promise<void> {
  // Wait for redirect to home
  await page.waitForFunction(
    () => document.querySelector('h2')?.textContent?.includes('Welcome to Liuboer'),
    { timeout: 10000 }
  );

  // Wait for session to disappear from sidebar
  await page.waitForFunction(
    (sid) => {
      const sessionElements = document.querySelectorAll('[data-session-id]');
      for (const el of sessionElements) {
        if (el.getAttribute('data-session-id') === sid) {
          return false;
        }
      }
      return true;
    },
    sessionId,
    { timeout: 5000 }
  );
}

/**
 * Wait for message to be sent and processing to complete
 */
export async function waitForMessageProcessed(page: Page, messageText: string): Promise<void> {
  // Wait for user message to appear
  await page.locator(`text="${messageText}"`).waitFor({ state: 'visible', timeout: 5000 });

  // Wait for processing state to appear and disappear
  const processingIndicator = page.locator('text=/Sending|Processing|Queued/i').first();

  // Wait for processing to start
  await processingIndicator.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
    // Processing might be too fast to catch
  });

  // Wait for processing to complete (indicator disappears)
  await processingIndicator.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {
    // If not found, assume processing is complete
  });

  // Wait for assistant response or error
  await page.waitForFunction(
    () => {
      const messages = document.querySelectorAll('[data-message-role]');
      const lastMessage = messages[messages.length - 1];
      return lastMessage?.getAttribute('data-message-role') === 'assistant' ||
             document.querySelector('[data-error-message]') !== null;
    },
    { timeout: 30000 }
  );

  // Input should be enabled again
  const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
  await messageInput.waitFor({ state: 'enabled', timeout: 5000 });
}

/**
 * Wait for state channel to be initialized and data loaded
 */
export async function waitForStateChannel(
  page: Page,
  channel: string,
  sessionId: string = 'global'
): Promise<void> {
  await page.waitForFunction(
    ({ chan, sid }) => {
      const state = (window as any).appState;
      if (!state) return false;

      if (sid === 'global') {
        return state.global?.value?.[chan]?.$ !== undefined;
      } else {
        return state.sessions?.get(sid)?.[chan]?.$ !== undefined;
      }
    },
    { chan: channel, sid: sessionId },
    { timeout: 10000 }
  );
}

/**
 * Wait for sessions list to be loaded in sidebar
 */
export async function waitForSessionsList(page: Page): Promise<void> {
  await waitForStateChannel(page, 'sessions', 'global');

  // Also wait for visual confirmation
  await page.waitForFunction(
    () => {
      const sidebar = document.querySelector('[data-sidebar]') ||
                     document.querySelector('aside');
      return sidebar !== null;
    },
    { timeout: 5000 }
  );
}

/**
 * Wait for specific SDK message type to appear
 */
export async function waitForSDKMessage(
  page: Page,
  messageType: string,
  timeout: number = 10000
): Promise<void> {
  await page.waitForFunction(
    (type) => {
      const messages = (window as any).__sdkMessages || [];
      return messages.some((m: any) => m.type === type);
    },
    messageType,
    { timeout }
  );
}

/**
 * Wait for specific event to be published
 */
export async function waitForEvent(
  page: Page,
  eventName: string,
  sessionId: string = 'global'
): Promise<any> {
  return page.evaluate(
    ({ event, sid }) => {
      return new Promise((resolve) => {
        const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
        if (!hub) {
          throw new Error('MessageHub not found');
        }

        const timeout = setTimeout(() => {
          resolve({ timeout: true });
        }, 10000);

        const unsubscribe = hub.subscribe(
          event,
          (data: any) => {
            clearTimeout(timeout);
            unsubscribe();
            resolve(data);
          },
          { sessionId: sid }
        );
      });
    },
    { event: eventName, sid: sessionId }
  );
}

/**
 * Wait for UI element with retry logic
 */
export async function waitForElement(
  page: Page,
  selector: string,
  options: {
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
    timeout?: number;
  } = {}
): Promise<Locator> {
  const element = page.locator(selector).first();
  await element.waitFor({
    state: options.state || 'visible',
    timeout: options.timeout || 10000,
  });
  return element;
}

/**
 * Wait for navigation to complete
 */
export async function waitForNavigation(page: Page, url?: string | RegExp): Promise<void> {
  if (url) {
    await page.waitForURL(url, { timeout: 10000 });
  } else {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  }
}

/**
 * Wait for multi-tab synchronization
 */
export async function waitForTabSync(pages: Page[], timeout: number = 5000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Check if all tabs have the same session count
    const sessionCounts = await Promise.all(
      pages.map(page =>
        page.evaluate(() => {
          const sessions = (window as any).appState?.global?.value?.sessions?.$.value?.sessions;
          return sessions?.length || 0;
        })
      )
    );

    // If all tabs have the same count, sync is likely complete
    if (sessionCounts.every(count => count === sessionCounts[0])) {
      // Wait a bit more to ensure full sync
      await pages[0].waitForTimeout(500);
      return;
    }

    // Wait before checking again
    await pages[0].waitForTimeout(100);
  }

  throw new Error(`Tab sync did not complete within ${timeout}ms`);
}

/**
 * Wait for agent state change
 */
export async function waitForAgentState(
  page: Page,
  sessionId: string,
  expectedState: 'idle' | 'working' | 'interrupted'
): Promise<void> {
  await page.waitForFunction(
    ({ sid, state }) => {
      const agentState = (window as any).appState?.sessions?.get(sid)?.agent?.$.value;
      return agentState?.status === state;
    },
    { sid: sessionId, state: expectedState },
    { timeout: 10000 }
  );
}

/**
 * Wait for context update (after /context command)
 */
export async function waitForContextUpdate(page: Page, sessionId: string): Promise<void> {
  // Wait for context state channel update
  await page.waitForFunction(
    (sid) => {
      const context = (window as any).appState?.sessions?.get(sid)?.context?.$.value;
      return context?.contextInfo !== null && context?.contextInfo !== undefined;
    },
    sessionId,
    { timeout: 10000 }
  );
}

/**
 * Wait for slash commands to be loaded
 */
export async function waitForSlashCommands(page: Page, sessionId: string): Promise<void> {
  await page.waitForFunction(
    (sid) => {
      const commands = (window as any).appState?.sessions?.get(sid)?.commands?.$.value;
      return commands?.availableCommands && commands.availableCommands.length > 0;
    },
    sessionId,
    { timeout: 10000 }
  );
}

/**
 * Helper to setup MessageHub exposure for testing
 */
export async function setupMessageHubTesting(page: Page): Promise<void> {
  // Inject script to expose MessageHub and track SDK messages
  await page.addInitScript(() => {
    // Track SDK messages
    (window as any).__sdkMessages = [];

    // Wait for MessageHub to be available and expose it
    const checkInterval = setInterval(() => {
      const hub = (window as any).appState?.messageHub;
      if (hub) {
        (window as any).__messageHub = hub;

        // Subscribe to SDK messages for tracking
        hub.subscribe('sdk.message', (msg: any) => {
          (window as any).__sdkMessages.push(msg);
        }, { sessionId: 'global' });

        clearInterval(checkInterval);
      }
    }, 100);
  });

  // Navigate and wait for setup
  await page.goto('/');
  await waitForWebSocketConnected(page);
}

/**
 * Helper to clean up after tests
 */
export async function cleanupTestSession(page: Page, sessionId: string): Promise<void> {
  try {
    // Navigate to session if not already there
    if (!page.url().includes(sessionId)) {
      await page.goto(`/${sessionId}`);
      await waitForElement(page, 'button[aria-label="Session options"]');
    }

    // Delete session
    await page.click('button[aria-label="Session options"]');
    await page.click('text=Delete Chat');

    const confirmButton = await waitForElement(page, '[data-testid="confirm-delete-session"]');
    await confirmButton.click();

    await waitForSessionDeleted(page, sessionId);
  } catch (error) {
    console.warn(`Failed to cleanup session ${sessionId}:`, error);
  }
}