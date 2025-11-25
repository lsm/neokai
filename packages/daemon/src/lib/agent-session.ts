import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Message, MessageContent, Session, ToolCall, ContextInfo } from "@liuboer/shared";
import type { MessageHub } from "@liuboer/shared";
import type { SDKUserMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import { Database } from "../storage/database";

/**
 * Queued message waiting to be sent to Claude
 */
interface QueuedMessage {
  id: string;
  content: string | MessageContent[];
  timestamp: string;
  resolve: (messageId: string) => void;
  reject: (error: Error) => void;
  internal?: boolean; // If true, don't save to DB or emit to client
}

/**
 * Agent Session - wraps a single session with Claude using Claude Agent SDK
 *
 * Uses STREAMING INPUT mode - a single persistent SDK query with AsyncGenerator
 * that continuously yields messages from a queue. This enables:
 * - Natural conversation flow
 * - Image upload support
 * - Message queueing
 * - Proper interruption handling
 */
export class AgentSession {
  private conversationHistory: Message[] = [];
  private abortController: AbortController | null = null;

  // Message queue for streaming input
  private messageQueue: QueuedMessage[] = [];
  private queryRunning: boolean = false;
  private messageWaiters: Array<() => void> = [];

  // SDK query object with control methods
  private queryObject: any | null = null;
  private slashCommands: string[] | null = null;

  // History replay tracking
  private replayingHistory: boolean = false;
  private historyReplayComplete: boolean = false;

  // PHASE 3 FIX: Store unsubscribe functions to prevent memory leaks
  private unsubscribers: Array<() => void> = [];

  // FIX: Track query promise for proper cleanup
  private queryPromise: Promise<void> | null = null;

  constructor(
    private session: Session,
    private db: Database,
    private messageHub: MessageHub,
    private getApiKey: () => Promise<string | null>, // Function to get current API key
  ) {
    // Load existing messages into conversation history
    this.loadConversationHistory();

    // Setup event listeners for incoming messages
    this.setupEventListeners();

    // Start the streaming query immediately
    this.startStreamingQuery().catch((error) => {
      console.error(`[AgentSession ${this.session.id}] Failed to start streaming query:`, error);
    });
  }

  /**
   * Load existing messages from database into conversation history
   */
  private loadConversationHistory(): void {
    const messages = this.db.getMessages(this.session.id);
    this.conversationHistory = messages;
  }

  /**
   * Setup MessageHub listeners for incoming messages and controls
   * PHASE 3 FIX: Store unsubscribe functions for cleanup
   */
  private setupEventListeners(): void {
    // Listen for incoming messages from WebSocket (session-scoped events)
    const unsubMessageSend = this.messageHub.subscribe('message.send', async (data: any) => {
      try {
        const { content, images } = data;
        const messageContent = this.buildMessageContent(content, images);
        const messageId = await this.enqueueMessage(messageContent);

        // Acknowledge that message was queued
        await this.messageHub.publish('message.queued',
          { messageId },
          { sessionId: this.session.id }
        );
      } catch (error) {
        console.error(`[AgentSession ${this.session.id}] Error handling message.send:`, error);
        await this.messageHub.publish('session.error',
          {
            error: error instanceof Error ? error.message : String(error),
          },
          { sessionId: this.session.id }
        );
      }
    }, { sessionId: this.session.id });

    // Handle interruption requests
    const unsubInterrupt = this.messageHub.subscribe('client.interrupt', async () => {
      this.handleInterrupt();
    }, { sessionId: this.session.id });

    // Store unsubscribe functions for cleanup
    this.unsubscribers.push(unsubMessageSend, unsubInterrupt);
  }

  /**
   * Build message content with text and optional images
   */
  private buildMessageContent(
    text: string,
    images?: Array<{ data: string; media_type: string }>
  ): string | MessageContent[] {
    if (!images || images.length === 0) {
      return text;
    }

    return [
      { type: "text" as const, text },
      ...images.map((img) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.media_type as any,
          data: img.data,
        },
      })),
    ];
  }

  /**
   * Enqueue a message to be sent to Claude via the streaming query
   */
  async enqueueMessage(content: string | MessageContent[], internal: boolean = false): Promise<string> {
    const messageId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const queuedMessage: QueuedMessage = {
        id: messageId,
        content,
        timestamp: new Date().toISOString(),
        resolve,
        reject,
        internal,
      };

      this.messageQueue.push(queuedMessage);

      // Wake up any waiting message generators
      this.messageWaiters.forEach((waiter) => waiter());
      this.messageWaiters = [];
    });
  }

  /**
   * DEPRECATED: Use enqueueMessage instead
   * Kept temporarily for HTTP endpoint backward compatibility
   */
  async sendMessage(content: string): Promise<string> {
    // Just delegate to enqueueMessage
    return this.enqueueMessage(content);
  }

  /**
   * AsyncGenerator that yields messages continuously from the queue
   * This is the heart of streaming input mode!
   */
  private async *messageGenerator(): AsyncGenerator<SDKUserMessage> {
    console.log(`[AgentSession ${this.session.id}] Message generator started`);

    // First, yield conversation history (if resuming session)
    if (this.conversationHistory.length > 0) {
      this.replayingHistory = true;
      console.log(`[AgentSession ${this.session.id}] Replaying ${this.conversationHistory.length} historical messages`);
    }

    for (const msg of this.conversationHistory) {
      if (msg.role === "user") {
        console.log(`[AgentSession ${this.session.id}] Yielding history message: ${msg.id}`);
        yield {
          type: "user" as const,
          uuid: msg.id as any,
          session_id: this.session.id,
          parent_tool_use_id: null,
          message: {
            role: "user" as const,
            content: msg.content,
          },
        };
      }
    }

    // Mark history replay as complete
    if (this.replayingHistory) {
      this.historyReplayComplete = true;
      this.replayingHistory = false;
      console.log(`[AgentSession ${this.session.id}] History replay complete`);
    }

    // Continuously yield new messages from queue
    while (this.queryRunning) {
      const queuedMessage = await this.waitForNextMessage();

      if (!queuedMessage) {
        console.log(`[AgentSession ${this.session.id}] No more messages, stopping generator`);
        break;
      }

      console.log(`[AgentSession ${this.session.id}] Yielding queued message: ${queuedMessage.id}${queuedMessage.internal ? ' (internal)' : ''}`);

      // Only save and emit if NOT internal (reserved for future use)
      if (!queuedMessage.internal) {
        // Save user message to DB
        const sdkUserMessage: SDKUserMessage = {
          type: "user" as const,
          uuid: queuedMessage.id as any,
          session_id: this.session.id,
          parent_tool_use_id: null,
          message: {
            role: "user" as const,
            content:
              typeof queuedMessage.content === "string"
                ? [{ type: "text" as const, text: queuedMessage.content }]
                : queuedMessage.content,
          },
        };

        this.db.saveSDKMessage(this.session.id, sdkUserMessage as any);

        // Emit user message
        await this.messageHub.publish(
          'sdk.message',
          sdkUserMessage,
          { sessionId: this.session.id }
        );

        // Emit processing status
        await this.messageHub.publish(
          'message.processing',
          { messageId: queuedMessage.id },
          { sessionId: this.session.id }
        );

        // Add to conversation history
        const userMessage: Message = {
          id: queuedMessage.id,
          sessionId: this.session.id,
          role: "user",
          content:
            typeof queuedMessage.content === "string"
              ? queuedMessage.content
              : JSON.stringify(queuedMessage.content),
          timestamp: queuedMessage.timestamp,
        };
        this.conversationHistory.push(userMessage);
      }

      // Yield to SDK
      yield {
        type: "user" as const,
        uuid: queuedMessage.id as any,
        session_id: this.session.id,
        parent_tool_use_id: null,
        message: {
          role: "user" as const,
          content: queuedMessage.content,
        },
      };

      // Resolve the promise to indicate message was sent
      queuedMessage.resolve(queuedMessage.id);
    }

    console.log(`[AgentSession ${this.session.id}] Message generator ended`);
  }

  /**
   * Wait for the next message to be enqueued
   */
  private async waitForNextMessage(): Promise<QueuedMessage | null> {
    while (this.queryRunning && this.messageQueue.length === 0) {
      // Wait for message to be enqueued
      await new Promise<void>((resolve) => {
        this.messageWaiters.push(resolve);
        // Also wake up after timeout to check queryRunning status
        setTimeout(resolve, 1000);
      });

      if (!this.queryRunning) return null;
    }

    return this.messageQueue.shift() || null;
  }

  /**
   * Start the long-running streaming query with AsyncGenerator
   */
  private async startStreamingQuery(): Promise<void> {
    if (this.queryRunning) {
      console.log(`[AgentSession ${this.session.id}] Query already running, skipping start`);
      return;
    }

    console.log(`[AgentSession ${this.session.id}] Starting streaming query...`);
    this.queryRunning = true;
    this.abortController = new AbortController();

    // FIX: Store query promise for cleanup
    this.queryPromise = this.runQuery();
  }

  /**
   * Run the query (extracted for promise tracking)
   */
  private async runQuery(): Promise<void> {
    try {
      // Verify authentication
      const hasAuth = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
      if (!hasAuth) {
        throw new Error("No authentication configured. Please set up OAuth or API key.");
      }

      // Ensure workspace exists
      const fs = await import("fs/promises");
      await fs.mkdir(this.session.workspacePath, { recursive: true });

      console.log(`[AgentSession ${this.session.id}] Creating streaming query with AsyncGenerator`);

      // Create query with AsyncGenerator!
      this.queryObject = query({
        prompt: this.messageGenerator(), // <-- AsyncGenerator!
        options: {
          model: this.session.config.model,
          cwd: this.session.workspacePath,
          abortController: this.abortController,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: Infinity, // Run forever!
        },
      });

      // Fetch and cache slash commands
      try {
        if (this.queryObject && typeof this.queryObject.supportedCommands === "function") {
          const commands = await this.queryObject.supportedCommands();
          this.slashCommands = commands.map((cmd: any) => cmd.name);
          console.log(`[AgentSession ${this.session.id}] Fetched slash commands:`, this.slashCommands);
        }
      } catch (error) {
        console.warn(`[AgentSession ${this.session.id}] Failed to fetch slash commands:`, error);
      }


      // Process SDK messages
      console.log(`[AgentSession ${this.session.id}] Processing SDK stream...`);
      for await (const message of this.queryObject) {
        await this.handleSDKMessage(message);
      }

      console.log(`[AgentSession ${this.session.id}] SDK stream ended`);
    } catch (error) {
      console.error(`[AgentSession ${this.session.id}] Streaming query error:`, error);

      // Reject all pending messages
      for (const msg of this.messageQueue) {
        msg.reject(error instanceof Error ? error : new Error(String(error)));
      }
      this.messageQueue = [];

      await this.messageHub.publish(
        'session.error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
        { sessionId: this.session.id }
      );
    } finally {
      this.queryRunning = false;
      console.log(`[AgentSession ${this.session.id}] Streaming query stopped`);
    }
  }

  /**
   * Handle incoming SDK messages
   */
  private async handleSDKMessage(message: any): Promise<void> {
    // Emit and save message
    await this.messageHub.publish(
      'sdk.message',
      message,
      { sessionId: this.session.id }
    );

    // Save to DB
    this.db.saveSDKMessage(this.session.id, message);

    // Handle specific message types
    if (message.type === "result") {
      // Update session metadata
      this.session.lastActiveAt = new Date().toISOString();
      this.session.metadata = {
        ...this.session.metadata,
        messageCount: (this.session.metadata?.messageCount || 0) + 1,
      };
      this.db.updateSession(this.session.id, {
        lastActiveAt: this.session.lastActiveAt,
        metadata: this.session.metadata,
      });
    }
  }


  /**
   * Handle interrupt request - clear queue and abort
   */
  private async handleInterrupt(): Promise<void> {
    console.log(`[AgentSession ${this.session.id}] Handling interrupt...`);

    // Clear pending messages
    for (const msg of this.messageQueue) {
      msg.reject(new Error("Interrupted by user"));
    }
    this.messageQueue = [];

    // Abort current query
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    await this.messageHub.publish('session.interrupted', {}, { sessionId: this.session.id });
  }


  /**
   * Get messages for this session
   */
  getMessages(limit?: number, offset?: number): Message[] {
    return this.db.getMessages(this.session.id, limit, offset);
  }

  /**
   * Get SDK messages for this session
   */
  getSDKMessages(limit?: number, offset?: number, since?: number) {
    return this.db.getSDKMessages(this.session.id, limit, offset, since);
  }

  /**
   * Get session data
   */
  getSessionData(): Session {
    return this.session;
  }

  /**
   * Update session metadata
   */
  updateMetadata(updates: Partial<Session>): void {
    if (updates.title) this.session.title = updates.title;
    if (updates.workspacePath) this.session.workspacePath = updates.workspacePath;
    if (updates.status) this.session.status = updates.status;
    if (updates.metadata) this.session.metadata = updates.metadata;

    this.db.updateSession(this.session.id, updates);
  }

  /**
   * Clear conversation history (for testing or reset)
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Reload conversation history from database
   * Useful after clearing messages or external updates
   */
  reloadHistory(): void {
    this.loadConversationHistory();
  }

  /**
   * Abort current query (delegates to handleInterrupt)
   */
  abort(): void {
    this.handleInterrupt();
  }

  /**
   * Cleanup resources when session is destroyed
   *
   * FIX: Made async and waits for query to stop properly
   * PHASE 3 FIX: Unsubscribe from all MessageHub subscriptions to prevent memory leaks
   */
  async cleanup(): Promise<void> {
    console.log(`[AgentSession ${this.session.id}] Cleaning up resources...`);

    // Unsubscribe from all MessageHub events
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        console.error(`[AgentSession ${this.session.id}] Error during unsubscribe:`, error);
      }
    }
    this.unsubscribers = [];

    // Signal query to stop
    this.queryRunning = false;

    // Abort any running query
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // FIX: Wait for query to fully stop (with timeout)
    if (this.queryPromise) {
      try {
        await Promise.race([
          this.queryPromise,
          new Promise((resolve) => setTimeout(resolve, 5000)), // 5s timeout
        ]);
      } catch (error) {
        // Ignore errors during cleanup
        console.warn(`[AgentSession ${this.session.id}] Query cleanup error:`, error);
      }
      this.queryPromise = null;
    }

    // Clear state
    this.messageQueue = [];
    this.messageWaiters = [];
    this.historyReplayComplete = false;
    this.replayingHistory = false;

    console.log(`[AgentSession ${this.session.id}] Cleanup complete`);
  }

  /**
   * Get available slash commands for this session
   * Returns cached commands or fetches from SDK if not yet available
   */
  async getSlashCommands(): Promise<string[]> {
    // Return cached if available
    if (this.slashCommands) {
      return this.slashCommands;
    }

    // Try to fetch from SDK query object
    if (this.queryObject && typeof this.queryObject.supportedCommands === "function") {
      try {
        const commands = await this.queryObject.supportedCommands();
        this.slashCommands = commands.map((cmd: any) => cmd.name);
        return this.slashCommands;
      } catch (error) {
        console.warn(`[AgentSession ${this.session.id}] Failed to fetch slash commands:`, error);
        return [];
      }
    }

    return [];
  }

}
