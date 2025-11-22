/**
 * RPC (Request/Response) over EventBus
 *
 * Provides a request/response pattern over WebSocket events with:
 * - Request ID correlation
 * - Timeout handling
 * - Type-safe request/response pairs
 * - Promise-based API
 */

import type { Event, EventType } from "../types";
import type { EventBus } from "./event-bus";
import { generateUUID } from "../utils";

/**
 * RPC Response data structure
 */
export interface RPCResponse<T = unknown> {
  requestId: string;
  success: boolean;
  result?: T;
  error?: string;
}

/**
 * RPC Request options
 */
export interface RPCRequestOptions {
  timeout?: number; // milliseconds, default 10000
  sessionId?: string; // Override session ID
}

/**
 * RPC Manager for request/response pattern over EventBus
 */
export class RPCManager {
  private pendingRequests = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout | number;
    }
  >();

  constructor(
    private eventBus: EventBus,
    private defaultSessionId: string,
  ) {
    // Listen to all response events
    this.setupResponseListeners();
  }

  /**
   * Setup listeners for all .response events
   */
  private setupResponseListeners(): void {
    this.eventBus.on("all", (event: Event) => {
      if (event.type.endsWith(".response")) {
        this.handleResponse(event);
      }
    });
  }

  /**
   * Handle incoming response events
   */
  private handleResponse(event: Event): void {
    const response = event.data as RPCResponse;
    const pending = this.pendingRequests.get(response.requestId);

    if (!pending) {
      console.warn(`[RPC] Received response for unknown request: ${response.requestId}`);
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeout as NodeJS.Timeout);
    this.pendingRequests.delete(response.requestId);

    // Resolve or reject
    if (response.success) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error || "Unknown error"));
    }
  }

  /**
   * Send a request and wait for response
   *
   * @param requestType - Event type for request (e.g., "session.create.request")
   * @param data - Request data
   * @param options - Request options
   * @returns Promise that resolves with response data
   */
  async request<T = unknown>(
    requestType: EventType,
    data: unknown,
    options: RPCRequestOptions = {},
  ): Promise<T> {
    const requestId = generateUUID();
    const sessionId = options.sessionId || this.defaultSessionId;
    const timeout = options.timeout || 10000;

    return new Promise<T>((resolve, reject) => {
      // Setup timeout
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      // Store pending request
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutHandle,
      });

      // Send request event
      this.eventBus
        .emit({
          id: requestId,
          type: requestType,
          sessionId,
          timestamp: new Date().toISOString(),
          data,
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          this.pendingRequests.delete(requestId);
          reject(error);
        });
    });
  }

  /**
   * Send a response event (server-side)
   *
   * @param requestId - Original request ID
   * @param responseType - Event type for response (e.g., "session.create.response")
   * @param sessionId - Session ID
   * @param result - Response data (on success)
   * @param error - Error message (on failure)
   */
  async respond(
    requestId: string,
    responseType: EventType,
    sessionId: string,
    result?: unknown,
    error?: string,
  ): Promise<void> {
    const response: RPCResponse = {
      requestId,
      success: !error,
      result,
      error,
    };

    await this.eventBus.emit({
      id: generateUUID(),
      type: responseType,
      sessionId,
      timestamp: new Date().toISOString(),
      data: response,
    });
  }

  /**
   * Cleanup all pending requests
   */
  cleanup(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout as NodeJS.Timeout);
      pending.reject(new Error("RPC Manager cleanup"));
    }
    this.pendingRequests.clear();
  }

  /**
   * Get count of pending requests
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Get the underlying EventBus
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }
}
