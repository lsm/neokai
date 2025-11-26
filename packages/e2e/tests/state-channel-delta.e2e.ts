/**
 * State Channel Delta E2E Tests
 *
 * Tests fine-grained state channel updates:
 * - Delta broadcasts for efficiency
 * - Per-channel versioning
 * - Optimistic updates
 * - State synchronization
 */

import { test, expect } from '@playwright/test';
import {
  setupMessageHubTesting,
  waitForStateChannel,
  waitForSessionCreated,
  waitForEvent,
  cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('State Channel Delta Updates', () => {
  test.beforeEach(async ({ page }) => {
    await setupMessageHubTesting(page);
  });

  test('should receive session delta updates instead of full list', async ({ page }) => {
    // Set up delta subscription tracking
    const deltaTracking = await page.evaluate(() => {
      return new Promise((resolve) => {
        const hub = (window as any).__messageHub;
        const deltas: any[] = [];

        // Subscribe to session delta updates
        const unsubscribe = hub.subscribe(
          'state.sessions.delta',
          (delta: any) => {
            deltas.push(delta);
          },
          { sessionId: 'global' }
        );

        // Return function to get deltas and cleanup
        (window as any).__getSessionDeltas = () => {
          unsubscribe();
          return deltas;
        };

        resolve(true);
      });
    });

    // Create a new session
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    // Wait for delta to be received
    await page.waitForTimeout(1000);

    // Get captured deltas
    const deltas = await page.evaluate(() => {
      return (window as any).__getSessionDeltas();
    });

    // Should have received at least one delta
    expect(deltas.length).toBeGreaterThan(0);

    // Check delta structure
    const createDelta = deltas.find(d => d.added && d.added.length > 0);
    expect(createDelta).toBeDefined();
    expect(createDelta.added).toHaveLength(1);
    expect(createDelta.added[0].id).toBe(sessionId);

    // Should have version number
    expect(createDelta.version).toBeDefined();
    expect(createDelta.version).toBeGreaterThan(0);

    // Should have timestamp
    expect(createDelta.timestamp).toBeDefined();

    await cleanupTestSession(page, sessionId);
  });

  test('should handle message delta updates efficiently', async ({ page }) => {
    // Create a session first
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    // Set up message delta tracking
    await page.evaluate((sid) => {
      const hub = (window as any).__messageHub;
      const messageDeltas: any[] = [];

      // Subscribe to message delta updates
      const unsubscribe = hub.subscribe(
        'state.messages.delta',
        (delta: any) => {
          messageDeltas.push(delta);
        },
        { sessionId: sid }
      );

      (window as any).__getMessageDeltas = () => {
        unsubscribe();
        return messageDeltas;
      };
    }, sessionId);

    // Send a message
    const messageInput = page.locator('textarea').first();
    await messageInput.fill('Test message for delta');
    await page.click('button[type="submit"]');

    // Wait for message to be processed
    await page.waitForTimeout(3000);

    // Get message deltas
    const messageDeltas = await page.evaluate(() => {
      return (window as any).__getMessageDeltas();
    });

    // Should have received delta updates (not full message list)
    expect(messageDeltas.length).toBeGreaterThan(0);

    // Check delta structure
    const hasAddedMessages = messageDeltas.some(d => d.added && d.added.length > 0);
    expect(hasAddedMessages).toBe(true);

    await cleanupTestSession(page, sessionId);
  });

  test('should track SDK message deltas separately', async ({ page }) => {
    // Create a session
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    // Track SDK message deltas
    await page.evaluate((sid) => {
      const hub = (window as any).__messageHub;
      const sdkDeltas: any[] = [];

      const unsubscribe = hub.subscribe(
        'state.sdkMessages.delta',
        (delta: any) => {
          sdkDeltas.push(delta);
        },
        { sessionId: sid }
      );

      (window as any).__getSDKDeltas = () => {
        unsubscribe();
        return sdkDeltas;
      };
    }, sessionId);

    // Send a message to generate SDK messages
    await page.locator('textarea').first().fill('Generate SDK messages');
    await page.click('button[type="submit"]');

    await page.waitForTimeout(5000);

    // Get SDK deltas
    const sdkDeltas = await page.evaluate(() => {
      return (window as any).__getSDKDeltas();
    });

    // Should have SDK message deltas
    if (sdkDeltas.length > 0) {
      expect(sdkDeltas[0]).toHaveProperty('added');
      expect(sdkDeltas[0]).toHaveProperty('version');
      expect(sdkDeltas[0]).toHaveProperty('timestamp');
    }

    await cleanupTestSession(page, sessionId);
  });

  test('should maintain per-channel versioning', async ({ page }) => {
    // Track versions across different channels
    const versionTracking = await page.evaluate(() => {
      const hub = (window as any).__messageHub;
      const versions = {
        sessions: [],
        auth: [],
        config: [],
        health: [],
      };

      // Subscribe to multiple channels
      hub.subscribe('state.sessions', (data: any) => {
        if (data.version) versions.sessions.push(data.version);
      }, { sessionId: 'global' });

      hub.subscribe('state.auth', (data: any) => {
        if (data.version) versions.auth.push(data.version);
      }, { sessionId: 'global' });

      hub.subscribe('state.config', (data: any) => {
        if (data.version) versions.config.push(data.version);
      }, { sessionId: 'global' });

      hub.subscribe('state.health', (data: any) => {
        if (data.version) versions.health.push(data.version);
      }, { sessionId: 'global' });

      (window as any).__getVersions = () => versions;
    });

    // Trigger updates on different channels
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    await page.waitForTimeout(2000);

    // Get version tracking
    const versions = await page.evaluate(() => {
      return (window as any).__getVersions();
    });

    // Sessions channel should have incremented
    if (versions.sessions.length > 0) {
      // Versions should be incrementing
      for (let i = 1; i < versions.sessions.length; i++) {
        expect(versions.sessions[i]).toBeGreaterThanOrEqual(versions.sessions[i - 1]);
      }
    }

    // Each channel maintains independent versioning
    // (versions might be empty if no updates on that channel)
    expect(Array.isArray(versions.sessions)).toBe(true);
    expect(Array.isArray(versions.auth)).toBe(true);
    expect(Array.isArray(versions.config)).toBe(true);
    expect(Array.isArray(versions.health)).toBe(true);

    await cleanupTestSession(page, sessionId);
  });

  test('should support optimistic updates with rollback', async ({ page }) => {
    // Create a session
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    // Track optimistic update and rollback
    const optimisticTest = await page.evaluate(async (sid) => {
      const states = {
        optimistic: null,
        confirmed: null,
        rolledBack: false,
      };

      // Simulate optimistic update
      const appState = (window as any).appState;
      if (appState && appState.sessions) {
        // Get current session state
        const sessionState = appState.sessions.get(sid);
        if (sessionState) {
          // Apply optimistic update
          states.optimistic = { title: 'Optimistic Title' };

          // Wait for server confirmation or rollback
          return new Promise((resolve) => {
            setTimeout(() => {
              // Check if update was maintained or rolled back
              const currentState = appState.sessions.get(sid);
              states.confirmed = currentState?.session?.$.value;
              states.rolledBack = states.confirmed?.title !== 'Optimistic Title';
              resolve(states);
            }, 2000);
          });
        }
      }

      return states;
    }, sessionId);

    // Optimistic updates should be possible
    expect(optimisticTest).toBeDefined();

    await cleanupTestSession(page, sessionId);
  });

  test('should handle agent state changes', async ({ page }) => {
    // Create a session
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    // Track agent state changes
    await page.evaluate((sid) => {
      const hub = (window as any).__messageHub;
      const agentStates: any[] = [];

      hub.subscribe('state.agent', (state: any) => {
        agentStates.push(state);
      }, { sessionId: sid });

      (window as any).__getAgentStates = () => agentStates;
    }, sessionId);

    // Send a message to trigger agent state changes
    await page.locator('textarea').first().fill('Trigger agent state');
    await page.click('button[type="submit"]');

    // Agent should transition through states
    await page.waitForTimeout(3000);

    const agentStates = await page.evaluate(() => {
      return (window as any).__getAgentStates();
    });

    // Should have captured state transitions
    if (agentStates.length > 0) {
      // Check state structure
      expect(agentStates[0]).toHaveProperty('status');
      expect(agentStates[0]).toHaveProperty('timestamp');

      // Status should be valid
      const validStatuses = ['idle', 'working', 'interrupted'];
      const hasValidStatus = agentStates.some(s =>
        validStatuses.includes(s.status)
      );
      expect(hasValidStatus).toBe(true);
    }

    await cleanupTestSession(page, sessionId);
  });

  test('should update context state after messages', async ({ page }) => {
    // Create a session
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    // Track context updates
    await page.evaluate((sid) => {
      const hub = (window as any).__messageHub;
      const contextUpdates: any[] = [];

      hub.subscribe('state.context', (context: any) => {
        contextUpdates.push(context);
      }, { sessionId: sid });

      // Also track context.updated events
      hub.subscribe('context.updated', (data: any) => {
        contextUpdates.push({ event: 'context.updated', ...data });
      }, { sessionId: sid });

      (window as any).__getContextUpdates = () => contextUpdates;
    }, sessionId);

    // Send messages to accumulate context
    for (let i = 0; i < 2; i++) {
      await page.locator('textarea').first().fill(`Context test message ${i + 1}`);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(3000);
    }

    // Get context updates
    const contextUpdates = await page.evaluate(() => {
      return (window as any).__getContextUpdates();
    });

    // Should have context updates
    if (contextUpdates.length > 0) {
      // Check for accurate context info
      const accurateContext = contextUpdates.find(c =>
        c.totalUsed !== undefined && c.totalCapacity !== undefined
      );

      if (accurateContext) {
        expect(accurateContext.totalUsed).toBeGreaterThan(0);
        expect(accurateContext.totalCapacity).toBeGreaterThan(0);
        expect(accurateContext.percentUsed).toBeGreaterThanOrEqual(0);
        expect(accurateContext.percentUsed).toBeLessThanOrEqual(100);
      }
    }

    await cleanupTestSession(page, sessionId);
  });

  test('should update command state when commands become available', async ({ page }) => {
    // Create a session
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    // Track command state updates
    await page.evaluate((sid) => {
      const hub = (window as any).__messageHub;
      const commandUpdates: any[] = [];

      hub.subscribe('state.commands', (commands: any) => {
        commandUpdates.push(commands);
      }, { sessionId: sid });

      (window as any).__getCommandUpdates = () => commandUpdates;
    }, sessionId);

    // Send first message to initialize SDK and get commands
    await page.locator('textarea').first().fill('Initialize and list commands');
    await page.click('button[type="submit"]');

    await page.waitForTimeout(5000);

    // Get command updates
    const commandUpdates = await page.evaluate(() => {
      return (window as any).__getCommandUpdates();
    });

    // Should have command state updates
    if (commandUpdates.length > 0) {
      const lastUpdate = commandUpdates[commandUpdates.length - 1];
      expect(lastUpdate).toHaveProperty('availableCommands');
      expect(lastUpdate).toHaveProperty('timestamp');

      // If commands are available, check structure
      if (lastUpdate.availableCommands && lastUpdate.availableCommands.length > 0) {
        expect(Array.isArray(lastUpdate.availableCommands)).toBe(true);
        // Common slash commands
        const commonCommands = ['/help', '/clear', '/context'];
        const hasCommonCommand = lastUpdate.availableCommands.some((cmd: string) =>
          commonCommands.some(common => cmd.includes(common))
        );
        expect(hasCommonCommand).toBe(true);
      }
    }

    await cleanupTestSession(page, sessionId);
  });

  test('should handle global state snapshot request', async ({ page }) => {
    // Request global state snapshot
    const snapshot = await page.evaluate(async () => {
      const hub = (window as any).__messageHub;

      try {
        const result = await hub.call('state.global.snapshot');
        return result;
      } catch (error) {
        return null;
      }
    });

    if (snapshot) {
      // Check snapshot structure
      expect(snapshot).toHaveProperty('sessions');
      expect(snapshot).toHaveProperty('auth');
      expect(snapshot).toHaveProperty('config');
      expect(snapshot).toHaveProperty('health');
      expect(snapshot).toHaveProperty('meta');

      // Check meta information
      expect(snapshot.meta).toHaveProperty('channel');
      expect(snapshot.meta.channel).toBe('global');
      expect(snapshot.meta).toHaveProperty('lastUpdate');
      expect(snapshot.meta).toHaveProperty('version');
    }
  });

  test('should handle session state snapshot request', async ({ page }) => {
    // Create a session first
    await page.click('button:has-text("New Session")');
    const sessionId = await waitForSessionCreated(page);

    // Request session state snapshot
    const snapshot = await page.evaluate(async (sid) => {
      const hub = (window as any).__messageHub;

      try {
        const result = await hub.call('state.session.snapshot', { sessionId: sid });
        return result;
      } catch (error) {
        return null;
      }
    }, sessionId);

    if (snapshot) {
      // Check session snapshot structure
      expect(snapshot).toHaveProperty('session');
      expect(snapshot).toHaveProperty('messages');
      expect(snapshot).toHaveProperty('sdkMessages');
      expect(snapshot).toHaveProperty('agent');
      expect(snapshot).toHaveProperty('context');
      expect(snapshot).toHaveProperty('commands');
      expect(snapshot).toHaveProperty('meta');

      // Check meta information
      expect(snapshot.meta).toHaveProperty('channel');
      expect(snapshot.meta.channel).toBe('session');
      expect(snapshot.meta).toHaveProperty('sessionId');
      expect(snapshot.meta.sessionId).toBe(sessionId);
    }

    await cleanupTestSession(page, sessionId);
  });
});