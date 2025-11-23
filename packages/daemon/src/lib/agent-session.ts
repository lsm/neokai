import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Message, MessageContent, Session, ToolCall, ContextInfo } from "@liuboer/shared";
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

  // Internal message tracking
  private processingInternalMessage: boolean = false;
  private internalMessageBuffer: any[] = [];

  // History replay tracking - prevents /context loop during startup
  private replayingHistory: boolean = false;
  private historyReplayComplete: boolean = false;

  // In-flight flag for /context calls - prevents concurrent calls
  private contextFetchInProgress: boolean = false;

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
  private async *messageGenerator(): AsyncGenerator<{
    type: "user";
    message: {
      role: "user";
      content: string | MessageContent[];
    };
  }> {
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

      // Set internal message tracking flag
      if (queuedMessage.internal) {
        this.processingInternalMessage = true;
        this.internalMessageBuffer = [];
      }

      // Only save and emit if NOT internal
      if (!queuedMessage.internal) {
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
      }

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
    // If processing internal message, buffer it instead of saving/emitting
    if (this.processingInternalMessage) {
      this.internalMessageBuffer.push(message);

      // Check if this is the result message (end of internal response)
      if (message.type === "result") {
        console.log(`[AgentSession ${this.session.id}] Internal /context command completed`);

        // Clear in-flight flag
        this.contextFetchInProgress = false;

        // Parse the full context info from the internal message buffer
        const contextInfo = this.parseContextInfo(this.internalMessageBuffer);

        if (contextInfo) {
          // Emit the full parsed context info to client
          await this.eventBus.emit({
            id: crypto.randomUUID(),
            type: "context.updated",
            sessionId: this.session.id,
            timestamp: new Date().toISOString(),
            data: {
              ...contextInfo,
              costUSD: message.total_cost_usd,
              durationMs: message.duration_ms,
            },
          });
        } else {
          // Fallback: emit basic context info from result message
          console.warn(`[AgentSession ${this.session.id}] Failed to parse context info, using fallback`);
          await this.eventBus.emit({
            id: crypto.randomUUID(),
            type: "context.updated",
            sessionId: this.session.id,
            timestamp: new Date().toISOString(),
            data: {
              model: null,
              totalUsed: message.usage.input_tokens + message.usage.output_tokens,
              totalCapacity: 200000,
              percentUsed: ((message.usage.input_tokens + message.usage.output_tokens) / 200000) * 100,
              breakdown: {},
              apiUsage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
                cacheReadTokens: message.usage.cache_read_input_tokens || 0,
                cacheCreationTokens: message.usage.cache_creation_input_tokens || 0,
              },
              costUSD: message.total_cost_usd,
              durationMs: message.duration_ms,
            },
          });
        }

        // Reset internal message tracking
        this.processingInternalMessage = false;
        this.internalMessageBuffer = [];
      }

      return; // Don't process further
    }

    // Normal message processing - emit and save
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
      // First emit basic token usage from API response
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

      // Silently fetch accurate context info using /context command
      // Only fetch if:
      // 1. Not already processing an internal message
      // 2. History replay is complete (prevents loop during startup)
      // 3. No context fetch already in progress (prevents concurrent calls)
      if (!this.processingInternalMessage && this.historyReplayComplete) {
        this.fetchContextInfo().catch(error => {
          console.warn(`[AgentSession ${this.session.id}] Failed to fetch context info:`, error);
        });
      }
    }
  }

  /**
   * Silently fetch context information using /context command
   * This runs internally and doesn't save to DB or emit to client
   */
  private async fetchContextInfo(): Promise<void> {
    // Skip if already fetching context (prevents concurrent calls)
    if (this.contextFetchInProgress) {
      console.log(`[AgentSession ${this.session.id}] Skipping /context fetch (already in progress)`);
      return;
    }

    try {
      this.contextFetchInProgress = true;
      console.log(`[AgentSession ${this.session.id}] Fetching context info with /context command`);
      await this.enqueueMessage("/context", true); // true = internal
    } catch (error) {
      console.error(`[AgentSession ${this.session.id}] Error fetching context info:`, error);
      // Clear flag on error
      this.contextFetchInProgress = false;
    }
  }

  /**
   * Parse context information from /context command response
   * The /context command returns markdown-formatted text in a user message
   */
  private parseContextInfo(messages: any[]): ContextInfo | null {
    try {
      // Find the user message with the context info (contains <local-command-stdout>)
      const userMessage = messages.find((msg: any) => {
        if (msg.type !== "user") return false;
        const content = msg.message?.content;
        if (typeof content === "string") {
          return content.includes("Context Usage") || content.includes("<local-command-stdout>");
        }
        return false;
      });

      if (!userMessage || !userMessage.message) {
        console.warn(`[AgentSession ${this.session.id}] No user message with context info found`);
        return null;
      }

      // Extract text content from the message
      let text = userMessage.message.content;
      if (typeof text !== "string") {
        console.warn(`[AgentSession ${this.session.id}] Context message content is not a string`);
        return null;
      }

      // Remove <local-command-stdout> tags if present
      text = text.replace(/<\/?local-command-stdout>/g, "").trim();

      console.log(`[AgentSession ${this.session.id}] Parsing context info from text:`, text.substring(0, 200));

      // Parse the markdown formatted context info
      const parsed: ContextInfo = {
        model: null,
        totalUsed: 0,
        totalCapacity: 0,
        percentUsed: 0,
        breakdown: {},
      };

      const lines = text.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Match "**Model:** claude-sonnet-4-5-20250929"
        const modelMatch = line.match(/\*\*Model:\*\*\s*(.+)/);
        if (modelMatch) {
          parsed.model = modelMatch[1].trim();
          continue;
        }

        // Match "**Tokens:** 65.8k / 200.0k (33%)"
        const tokensMatch = line.match(/\*\*Tokens:\*\*\s*([\d.]+)(k?)\s*\/\s*([\d.]+)(k?)\s*\((\d+(?:\.\d+)?)%\)/);
        if (tokensMatch) {
          // Convert k notation to actual numbers
          const parseTokens = (numStr: string, kSuffix: string) => {
            const num = parseFloat(numStr);
            return kSuffix.toLowerCase() === 'k' ? Math.round(num * 1000) : num;
          };

          parsed.totalUsed = parseTokens(tokensMatch[1], tokensMatch[2]);
          parsed.totalCapacity = parseTokens(tokensMatch[3], tokensMatch[4]);
          parsed.percentUsed = parseFloat(tokensMatch[5]);
          continue;
        }

        // Parse markdown table rows (skip header and separator)
        const tableRowMatch = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
        if (tableRowMatch) {
          const category = tableRowMatch[1].trim();
          const tokensStr = tableRowMatch[2].trim();
          const percentStr = tableRowMatch[3].trim();

          // Skip table headers and separators
          if (
            category.toLowerCase() === "category" ||
            category.includes("---") ||
            tokensStr.toLowerCase() === "tokens" ||
            tokensStr.includes("---")
          ) {
            continue;
          }

          // Parse tokens (handle "3.0k" format and plain numbers like "8")
          let tokens = 0;
          if (tokensStr.toLowerCase().includes("k")) {
            tokens = Math.round(parseFloat(tokensStr.replace(/k/i, "")) * 1000);
          } else {
            tokens = parseInt(tokensStr.replace(/,/g, ""));
          }

          // Parse percentage (handle "1.5%" format)
          const percent = parseFloat(percentStr.replace("%", ""));

          parsed.breakdown[category] = {
            tokens,
            percent: isNaN(percent) ? null : percent,
          };
          continue;
        }

        // Match "**Commands:** 0"
        const commandsMatch = line.match(/\*\*Commands:\*\*\s*(\d+)/);
        if (commandsMatch) {
          if (!parsed.slashCommandTool) {
            parsed.slashCommandTool = { commands: 0, totalTokens: 0 };
          }
          parsed.slashCommandTool.commands = parseInt(commandsMatch[1]);
          continue;
        }

        // Match "**Total tokens:** 864"
        const totalTokensMatch = line.match(/\*\*Total tokens:\*\*\s*(\d+(?:,\d+)*)/);
        if (totalTokensMatch) {
          if (!parsed.slashCommandTool) {
            parsed.slashCommandTool = { commands: 0, totalTokens: 0 };
          }
          parsed.slashCommandTool.totalTokens = parseInt(totalTokensMatch[1].replace(/,/g, ""));
          continue;
        }
      }

      // Also include the result message for API usage details
      const resultMessage = messages.find((msg: any) => msg.type === "result");
      if (resultMessage && resultMessage.usage) {
        parsed.apiUsage = {
          inputTokens: resultMessage.usage.input_tokens,
          outputTokens: resultMessage.usage.output_tokens,
          cacheReadTokens: resultMessage.usage.cache_read_input_tokens || 0,
          cacheCreationTokens: resultMessage.usage.cache_creation_input_tokens || 0,
        };
      }

      console.log(`[AgentSession ${this.session.id}] Parsed context info:`, JSON.stringify(parsed, null, 2));
      return parsed;
    } catch (error) {
      console.error(`[AgentSession ${this.session.id}] Error parsing context info:`, error);
      return null;
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
