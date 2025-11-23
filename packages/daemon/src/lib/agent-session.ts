import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Message, MessageContent, Session, ToolCall } from "@liuboer/shared";
import { EventBus } from "@liuboer/shared";
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

  constructor(
    private session: Session,
    private db: Database,
    private eventBus: EventBus,
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
   * Setup EventBus listeners for incoming messages and controls
   */
  private setupEventListeners(): void {
    // Listen for incoming messages from WebSocket
    this.eventBus.on("message.send", async (event: any) => {
      try {
        const { content, images } = event.data;
        const messageContent = this.buildMessageContent(content, images);
        const messageId = await this.enqueueMessage(messageContent);

        // Acknowledge that message was queued
        await this.eventBus.emit({
          id: crypto.randomUUID(),
          type: "message.queued",
          sessionId: this.session.id,
          timestamp: new Date().toISOString(),
          data: { messageId },
        });
      } catch (error) {
        console.error(`[AgentSession ${this.session.id}] Error handling message.send:`, error);
        await this.eventBus.emit({
          id: crypto.randomUUID(),
          type: "error",
          sessionId: this.session.id,
          timestamp: new Date().toISOString(),
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });

    // Handle interruption requests
    this.eventBus.on("client.interrupt", async () => {
      this.handleInterrupt();
    });
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
  async enqueueMessage(content: string | MessageContent[]): Promise<string> {
    const messageId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const queuedMessage: QueuedMessage = {
        id: messageId,
        content,
        timestamp: new Date().toISOString(),
        resolve,
        reject,
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
  private async *messageGenerator(): AsyncGenerator<{
    type: "user";
    message: {
      role: "user";
      content: string | MessageContent[];
    };
  }> {
    console.log(`[AgentSession ${this.session.id}] Message generator started`);

    // First, yield conversation history (if resuming session)
    for (const msg of this.conversationHistory) {
      if (msg.role === "user") {
        console.log(`[AgentSession ${this.session.id}] Yielding history message: ${msg.id}`);
        yield {
          type: "user" as const,
          message: {
            role: "user" as const,
            content: msg.content,
          },
        };
      }
    }

    // Continuously yield new messages from queue
    while (this.queryRunning) {
      const queuedMessage = await this.waitForNextMessage();

      if (!queuedMessage) {
        console.log(`[AgentSession ${this.session.id}] No more messages, stopping generator`);
        break;
      }

      console.log(`[AgentSession ${this.session.id}] Yielding queued message: ${queuedMessage.id}`);

      // Save user message to DB
      const sdkUserMessage = {
        type: "user" as const,
        uuid: queuedMessage.id,
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

      this.db.saveSDKMessage(this.session.id, sdkUserMessage);

      // Emit user message
      await this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "sdk.message",
        sessionId: this.session.id,
        timestamp: new Date().toISOString(),
        data: sdkUserMessage,
      });

      // Emit processing status
      await this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "message.processing",
        sessionId: this.session.id,
        timestamp: new Date().toISOString(),
        data: { messageId: queuedMessage.id },
      });

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

      // Yield to SDK
      yield {
        type: "user" as const,
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

      await this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "error",
        sessionId: this.session.id,
        timestamp: new Date().toISOString(),
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.queryRunning = false;
      console.log(`[AgentSession ${this.session.id}] Streaming query stopped`);
    }
  }

  /**
   * Handle incoming SDK messages
   */
  private async handleSDKMessage(message: any): Promise<void> {
    // Emit all SDK messages
    await this.eventBus.emit({
      id: crypto.randomUUID(),
      type: "sdk.message",
      sessionId: this.session.id,
      timestamp: new Date().toISOString(),
      data: message,
    });

    // Save to DB
    this.db.saveSDKMessage(this.session.id, message);

    // Handle specific message types
    if (message.type === "result") {
      await this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "context.updated",
        sessionId: this.session.id,
        timestamp: new Date().toISOString(),
        data: {
          tokenUsage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens || 0,
            cacheCreationTokens: message.usage.cache_creation_input_tokens || 0,
          },
          modelUsage: message.modelUsage,
          costUSD: message.total_cost_usd,
          durationMs: message.duration_ms,
        },
      });

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

    await this.eventBus.emit({
      id: crypto.randomUUID(),
      type: "session.interrupted",
      sessionId: this.session.id,
      timestamp: new Date().toISOString(),
      data: {},
    });
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
