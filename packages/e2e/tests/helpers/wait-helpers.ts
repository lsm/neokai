/**
 * Event-based wait helpers to replace arbitrary timeouts
 *
 * These helpers wait for specific conditions or events instead of fixed timeouts,
 * making tests more reliable and faster.
 */

import type { Page, Locator } from '@playwright/test';

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
  // Wait for the input to be enabled (not disabled)
  await page.waitForFunction(
    () => {
      const input = document.querySelector('textarea[placeholder*="Ask"]') as HTMLTextAreaElement;
      return input && !input.disabled;
    },
    { timeout: 5000 }
  );

  // Get and return the session ID
  const sessionId = await page.evaluate(() => {
    // Try multiple ways to get session ID
    // 1. From appState's private field (if exposed)
    const appStateSessionId = (window as any).appState?.currentSessionIdSignal?.value;
    if (appStateSessionId) return appStateSessionId;

    // 2. From global currentSessionIdSignal (if exposed)
    const globalSignal = (window as any).currentSessionIdSignal?.value;
    if (globalSignal) return globalSignal;

    // 3. From localStorage
    const localStorageId = localStorage.getItem("currentSessionId");
    if (localStorageId) return localStorageId;

    // 4. From URL path
    const pathId = window.location.pathname.split('/').filter(Boolean)[0];
    if (pathId && pathId !== 'undefined') return pathId;

    // 5. From latest session in sessions list
    const sessions = (window as any).appState?.global?.value?.sessions?.$.value?.sessions || [];
    const latestSession = sessions[sessions.length - 1];
    if (latestSession?.id) return latestSession.id;

    return null;
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
  await messageInput.waitFor({ state: 'visible', timeout: 5000 });
  // Wait for the input to be enabled (not disabled)
  await page.waitForFunction(
    () => {
      const input = document.querySelector('textarea[placeholder*="Ask"]') as HTMLTextAreaElement;
      return input && !input.disabled;
    },
    { timeout: 5000 }
  );
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
    async ({ event, sid }) => {
      return new Promise(async (resolve) => {
        const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
        if (!hub) {
          throw new Error('MessageHub not found');
        }

        const timeout = setTimeout(() => {
          resolve({ timeout: true });
        }, 10000);

        const unsubscribe = await hub.subscribe(
          event,
          async (data: any) => {
            clearTimeout(timeout);
            await unsubscribe();
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
    const checkInterval = setInterval(async () => {
      const hub = (window as any).appState?.messageHub;
      if (hub) {
        (window as any).__messageHub = hub;

        // Subscribe to SDK messages for tracking
        await hub.subscribe('sdk.message', (msg: any) => {
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
 * IMPORTANT: E2E tests must test the actual UI, not bypass it
 */
export async function cleanupTestSession(page: Page, sessionId: string): Promise<void> {
  try {
    // Navigate to session if not already there
    if (!page.url().includes(sessionId)) {
      await page.goto(`/${sessionId}`);
      await page.waitForTimeout(1000); // Wait for page to fully load and stabilize
    }

    // Find and click the session options button
    const optionsButton = page.locator('button[aria-label="Session options"]').first();
    await optionsButton.waitFor({ state: 'visible', timeout: 5000 });

    // Scroll into view to ensure it's visible
    await optionsButton.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // Click to open dropdown
    await optionsButton.click();

    // Wait for dropdown menu to appear and be ready for interaction
    await page.waitForTimeout(500);

    // Find the "Delete Chat" button in the dropdown menu using more specific selector
    const deleteButton = page.locator('button[role="menuitem"]').filter({ hasText: 'Delete Chat' }).first();
    await deleteButton.waitFor({ state: 'visible', timeout: 5000 });

    // Ensure the button is ready for interaction
    await deleteButton.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    // Click the delete button
    await deleteButton.click();

    // Wait for modal to appear
    await page.waitForTimeout(300);

    // Find and click the confirm button in the modal
    const confirmButton = page.locator('[data-testid="confirm-delete-session"]').first();
    await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
    await confirmButton.click();

    // Wait for session deletion and UI update
    await waitForSessionDeleted(page, sessionId);
  } catch (error) {
    console.warn(`Failed to cleanup session ${sessionId}:`, (error as Error).message || error);
    // Try to navigate home if cleanup failed
    try {
      await page.goto('/');
      await page.waitForTimeout(500);
    } catch {
      // Ignore navigation errors
    }
  }
}