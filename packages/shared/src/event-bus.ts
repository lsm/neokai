/**
 * EventBus - Mediator pattern for breaking circular dependencies
 *
 * Provides a central event coordination point between components
 * without requiring direct dependencies.
 *
 * ARCHITECTURE:
 * - SessionManager emits events (no dependency on StateManager)
 * - StateManager listens to events (read-only dependency on SessionManager)
 * - AuthManager emits events (no dependency on StateManager)
 * - No circular dependencies!
 *
 * Events are typed for safety and IDE autocomplete.
 *
 * SESSION FILTERING:
 * Uses nested Map structure (event → sessionId → handlers) for O(1) handler lookup.
 * No if/else checks needed - direct Map access based on event's sessionId.
 */

import type {
  Session,
  AuthMethod,
  ContextInfo,
  MessageContent,
  MessageImage,
} from "./types.ts";
import type { SDKMessage } from "./sdk/sdk.d.ts";
import type {
  AgentProcessingState,
  ApiConnectionState,
} from "./state-types.ts";

export type UnsubscribeFn = () => void;

/**
 * Event handler function
 */
export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

/**
 * Compaction trigger type
 */
export type CompactionTrigger = "manual" | "auto";

/**
 * Event types for type safety
 *
 * Design principle: Publishers include their data in events.
 * StateManager maintains its own state from events (no fetching from sources).
 * This ensures full decoupling between components via EventBus.
 */
export interface EventMap {
  // Session lifecycle events
  "session:created": { sessionId: string; session: Session };
  "session:updated": {
    sessionId: string;
    source?: string;
    // Include the data that changed - StateManager caches these
    session?: Partial<Session>;
    processingState?: AgentProcessingState;
  };
  "session:deleted": { sessionId: string };

  // SDK events
  "sdk:message": { sessionId: string; message: SDKMessage };

  // Auth events (global events - use 'global' as sessionId)
  "auth:changed": {
    sessionId: string;
    method: AuthMethod;
    isAuthenticated: boolean;
  };

  // API connection events - internal server-side only (global events - use 'global' as sessionId)
  "api:connection": { sessionId: string } & ApiConnectionState;

  // Settings events (global events - use 'global' as sessionId)
  "settings:updated": {
    sessionId: string;
    settings: import("./types/settings.ts").GlobalSettings;
  };
  "sessions:filter-changed": { sessionId: string }; // Global event - use 'global' as sessionId

  // Commands events
  "commands:updated": { sessionId: string; commands: string[] };

  // Context events - real-time context window usage tracking
  "context:updated": { sessionId: string; contextInfo: ContextInfo };

  // Compaction events - emitted when SDK auto-compacts or user triggers /compact
  "context:compacting": { sessionId: string; trigger: CompactionTrigger };
  "context:compacted": {
    sessionId: string;
    trigger: CompactionTrigger;
    preTokens: number;
  };

  // Session error events - folded into unified state.session
  "session:error": { sessionId: string; error: string; details?: unknown };
  "session:error:clear": { sessionId: string };

  // Message events - emitted when user sends a message
  "message:sent": { sessionId: string };

  // Title generation events
  "title:generated": { sessionId: string; title: string };
  "title:generation:failed": {
    sessionId: string;
    error: Error;
    attempts: number;
  };

  // AskUserQuestion events - emitted when agent asks user a question
  "question:asked": {
    sessionId: string;
    pendingQuestion: import("./state-types.ts").PendingUserQuestion;
  };

  // User message processing events (3-layer communication pattern)
  // Emitted by RPC handler after persisting message, processed async by SessionManager
  "user-message:persisted": {
    sessionId: string;
    messageId: string;
    messageContent: string | MessageContent[];
    userMessageText: string;
    needsWorkspaceInit: boolean;
    hasDraftToClear: boolean;
    // When true, skip SDK query start (caller handles it separately)
    // Used by handleMessageSend() which needs workspace init but handles query itself
    skipQueryStart?: boolean;
  };

  // =====================================================
  // EventBus-centric architecture: RPC → EventBus → AgentSession
  // RPC handlers emit these events, AgentSession subscribes with sessionId filtering
  // =====================================================

  // Model switch request (from RPC handler)
  "model:switch:request": { sessionId: string; model: string };
  // Model switch result (from AgentSession)
  "model:switched": {
    sessionId: string;
    success: boolean;
    model: string;
    error?: string;
  };

  // Interrupt request (from RPC handler)
  "agent:interrupt:request": { sessionId: string };
  // Interrupt completed (from AgentSession)
  "agent:interrupted": { sessionId: string };

  // Reset query request (from RPC handler)
  "agent:reset:request": { sessionId: string; restartQuery?: boolean };
  // Reset completed (from AgentSession)
  "agent:reset": { sessionId: string; success: boolean; error?: string };

  // Message sending events (EventBus-centric pattern)
  // RPC handler emits message:send:request → SessionManager persists → emits message:persisted
  "message:send:request": {
    sessionId: string;
    messageId: string;
    content: string;
    images?: MessageImage[];
  };
  // Message persisted event (from SessionManager to AgentSession + SessionManager)
  "message:persisted": {
    sessionId: string;
    messageId: string;
    messageContent: string | MessageContent[];
    userMessageText: string;
    needsWorkspaceInit: boolean;
    hasDraftToClear: boolean;
  };
}

/**
 * Special sessionId constant for global (non-session-specific) handlers
 */
const GLOBAL_SESSION_ID = "__global__";

/**
 * EventBus class
 *
 * Simple pub/sub for internal application events.
 * NOT to be confused with MessageHub (which is for client-server communication).
 * This is purely server-side component coordination.
 *
 * PERFORMANCE ARCHITECTURE:
 * - Nested Map structure: event → sessionId → Set<handler>
 * - O(1) handler lookup by sessionId (no iteration, no if/else checks)
 * - Handlers organized by session for efficient filtering
 */
export class EventBus {
  // Nested map: event → sessionId → handlers
  private handlers: Map<string, Map<string, Set<EventHandler>>> = new Map();
  private debug: boolean;

  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug || false;
  }

  /**
   * Emit an event to all registered handlers
   *
   * PERFORMANCE: O(1) lookup for session-specific handlers + O(1) lookup for global handlers
   * No iteration over non-matching handlers, no if/else checks
   */
  async emit<K extends keyof EventMap>(
    event: K,
    data: EventMap[K],
  ): Promise<void> {
    this.log(`Emitting event: ${String(event)}`, data);

    const eventKey = String(event);
    const sessionMap = this.handlers.get(eventKey);

    if (!sessionMap || sessionMap.size === 0) {
      this.log(`No handlers for event: ${eventKey}`);
      return;
    }

    // Extract sessionId from event data
    const eventData = data as { sessionId: string };
    const sessionId = eventData.sessionId;

    // Execute handlers in TWO groups (no iteration over non-matching handlers!)
    const promises: Promise<void>[] = [];

    // 1. Session-specific handlers (direct lookup - O(1))
    const sessionHandlers = sessionMap.get(sessionId);
    if (sessionHandlers) {
      for (const handler of sessionHandlers) {
        try {
          const result = handler(data);
          if (result instanceof Promise) {
            promises.push(
              result.catch((error) => {
                console.error(
                  `[EventBus] Async handler error for ${eventKey}:`,
                  error,
                );
              }),
            );
          }
        } catch (error) {
          console.error(`[EventBus] Error in handler for ${eventKey}:`, error);
        }
      }
    }

    // 2. Global handlers (direct lookup - O(1))
    const globalHandlers = sessionMap.get(GLOBAL_SESSION_ID);
    if (globalHandlers) {
      for (const handler of globalHandlers) {
        try {
          const result = handler(data);
          if (result instanceof Promise) {
            promises.push(
              result.catch((error) => {
                console.error(
                  `[EventBus] Async handler error for ${eventKey}:`,
                  error,
                );
              }),
            );
          }
        } catch (error) {
          console.error(`[EventBus] Error in handler for ${eventKey}:`, error);
        }
      }
    }

    // Wait for all async handlers to complete
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Register an event handler with optional session filtering
   *
   * PERFORMANCE: Handlers stored in nested map by sessionId for O(1) lookup during emit
   * No wrapper functions, no if/else checks during execution
   *
   * @param event - Event name to listen for
   * @param handler - Handler function to execute
   * @param options - Optional configuration:
   *   - sessionId: Filter events to only this session (stored in dedicated map slot)
   *
   * @example
   * // Global subscription (all sessions)
   * eventBus.on('session:created', handler);
   *
   * // Session-scoped subscription (direct map lookup, no filtering)
   * eventBus.on('message:persisted', handler, { sessionId: 'abc123' });
   */
  on<K extends keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    options?: { sessionId?: string },
  ): UnsubscribeFn {
    const eventKey = String(event);
    const sessionId = options?.sessionId || GLOBAL_SESSION_ID;

    // Initialize nested maps if needed
    if (!this.handlers.has(eventKey)) {
      this.handlers.set(eventKey, new Map());
    }

    const sessionMap = this.handlers.get(eventKey)!;
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, new Set());
    }

    // Add handler directly to session-specific set (no wrapping!)
    sessionMap.get(sessionId)!.add(handler as EventHandler);

    if (options?.sessionId) {
      this.log(
        `Registered session-scoped handler for: ${eventKey} (session: ${sessionId})`,
      );
    } else {
      this.log(`Registered global handler for: ${eventKey}`);
    }

    // Return unsubscribe function
    return () => {
      const sessionMap = this.handlers.get(eventKey);
      if (sessionMap) {
        const handlers = sessionMap.get(sessionId);
        if (handlers) {
          handlers.delete(handler as EventHandler);

          // Cleanup empty sets to prevent memory leaks
          if (handlers.size === 0) {
            sessionMap.delete(sessionId);
          }
        }

        // Cleanup empty maps
        if (sessionMap.size === 0) {
          this.handlers.delete(eventKey);
        }
      }

      if (options?.sessionId) {
        this.log(
          `Unregistered session-scoped handler for: ${eventKey} (session: ${sessionId})`,
        );
      } else {
        this.log(`Unregistered global handler for: ${eventKey}`);
      }
    };
  }

  /**
   * Register a one-time event handler (auto-unsubscribes after first call)
   * Supports optional session filtering like on()
   *
   * @param event - Event name to listen for
   * @param handler - Handler function to execute (only once)
   * @param options - Optional configuration:
   *   - sessionId: Filter events to only this session
   *
   * @example
   * // One-time global subscription
   * eventBus.once('session:created', handler);
   *
   * // One-time session-scoped subscription
   * eventBus.once('message:persisted', handler, { sessionId: 'abc123' });
   */
  once<K extends keyof EventMap>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    options?: { sessionId?: string },
  ): UnsubscribeFn {
    let unsubscribe: UnsubscribeFn | null = null;

    const wrappedHandler = async (data: EventMap[K]) => {
      if (unsubscribe) {
        unsubscribe();
      }
      await handler(data);
    };

    unsubscribe = this.on(event, wrappedHandler, options);
    return unsubscribe;
  }

  /**
   * Remove all handlers for an event
   */
  off(event: keyof EventMap): void {
    this.handlers.delete(String(event));
    this.log(`Removed all handlers for: ${String(event)}`);
  }

  /**
   * Get handler count for an event (for debugging)
   * Returns total count across all sessions
   */
  getHandlerCount(event: keyof EventMap): number {
    const sessionMap = this.handlers.get(String(event));
    if (!sessionMap) return 0;

    let total = 0;
    for (const handlers of sessionMap.values()) {
      total += handlers.size;
    }
    return total;
  }

  /**
   * Get handler count for a specific session (for debugging)
   */
  getHandlerCountForSession(event: keyof EventMap, sessionId: string): number {
    const sessionMap = this.handlers.get(String(event));
    if (!sessionMap) return 0;

    const handlers = sessionMap.get(sessionId);
    return handlers?.size || 0;
  }

  /**
   * Clear all handlers (for cleanup)
   */
  clear(): void {
    this.handlers.clear();
    this.log("Cleared all handlers");
  }

  /**
   * Debug logging
   */
  private log(message: string, ...args: unknown[]): void {
    if (this.debug) {
      console.log(`[EventBus] ${message}`, ...args);
    }
  }
}
