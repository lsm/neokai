import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Message, Session, ToolCall } from "@liuboer/shared";
import { Database } from "../storage/database";
import { EventBus } from "./event-bus";

/**
 * Agent Session - wraps a single session with Claude using Claude Agent SDK
 *
 * Handles message streaming, tool execution, and event broadcasting.
 * Uses the high-level Agent SDK which provides automatic tool execution,
 * conversation management, and streaming.
 */
export class AgentSession {
  private conversationHistory: Message[] = [];
  private abortController: AbortController | null = null;

  constructor(
    private session: Session,
    private db: Database,
    private eventBus: EventBus,
    private getApiKey: () => Promise<string | null>, // Function to get current API key
  ) {
    // Load existing messages into conversation history
    this.loadConversationHistory();
  }

  /**
   * Load existing messages from database into conversation history
   */
  private loadConversationHistory(): void {
    const messages = this.db.getMessages(this.session.id);
    this.conversationHistory = messages;
  }

  /**
   * Send a message to Claude and handle the response with streaming
   */
  async sendMessage(content: string): Promise<string> {
    const messageId = crypto.randomUUID();

    // Add to conversation history for SDK prompt building
    const userMessage: Message = {
      id: messageId,
      sessionId: this.session.id,
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };
    this.conversationHistory.push(userMessage);

    // Create SDK user message format and save it to database
    // The SDK doesn't echo back user messages, so we need to save it ourselves
    const sdkUserMessage = {
      type: "user" as const,
      uuid: messageId,
      session_id: this.session.id,
      parent_tool_use_id: null,
      message: {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: content,
          },
        ],
      },
    };

    // Save user message to sdk_messages table
    // Note: We don't emit here - the SDK stream will include the user message and emit it
    this.db.saveSDKMessage(this.session.id, sdkUserMessage);

    // Emit the user message to the client so it appears in the UI
    await this.eventBus.emit({
      id: crypto.randomUUID(),
      type: "sdk.message",
      sessionId: this.session.id,
      timestamp: new Date().toISOString(),
      data: sdkUserMessage,
    });

    // Emit message start event (legacy)
    await this.eventBus.emit({
      id: crypto.randomUUID(),
      type: "message.start",
      sessionId: this.session.id,
      timestamp: new Date().toISOString(),
      data: {
        messageId,
        role: "user",
        content,
      },
    });

    try {
      // Verify authentication is configured
      // The environment variables are already set at daemon startup, no need to modify them
      const hasAuth = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
      console.log("[DEBUG] Authentication check:");
      console.log("[DEBUG]   CLAUDE_CODE_OAUTH_TOKEN:", process.env.CLAUDE_CODE_OAUTH_TOKEN ? "SET" : "NOT SET");
      console.log("[DEBUG]   ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "SET" : "NOT SET");

      if (!hasAuth) {
        throw new Error("No authentication configured. Please set up OAuth or API key.");
      }

      // Create abort controller for this query
      this.abortController = new AbortController();

      // Call Claude Agent SDK with streaming
      const assistantMessageId = crypto.randomUUID();
      let assistantContent = "";
      const toolCalls: ToolCall[] = [];

      // Build the prompt with conversation history
      const conversationPrompt = this.buildConversationPrompt(content);

      // Ensure workspace directory exists before creating SDK query
      // The SDK subprocess needs a valid cwd or it will hang without yielding messages
      const fs = await import("fs/promises");
      try {
        await fs.mkdir(this.session.workspacePath, { recursive: true });
        console.log("[DEBUG] Workspace directory ensured:", this.session.workspacePath);
      } catch (error) {
        console.error("[DEBUG] Failed to create workspace directory:", error);
        throw new Error(`Failed to create workspace directory: ${this.session.workspacePath}`);
      }

      // Create query with Agent SDK
      console.log("[DEBUG] Session workspace path:", this.session.workspacePath);
      console.log("[DEBUG] Query options:", {
        model: this.session.config.model,
        cwd: this.session.workspacePath,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 10,
      });
      const queryStream = query({
        prompt: conversationPrompt,
        options: {
          model: this.session.config.model,
          // Set cwd to workspace path so SDK subprocess runs in correct directory
          cwd: this.session.workspacePath,
          abortController: this.abortController,
          // Use bypassPermissions mode for non-interactive daemon
          permissionMode: "bypassPermissions",
          // Allow bypassing all permission checks for daemon/test mode
          allowDangerouslySkipPermissions: true,
          // Limit turns to prevent infinite loops
          maxTurns: 10,
        },
      });

      // Process the stream
      console.log("[DEBUG] Starting to process SDK stream...");
      for await (const message of queryStream) {
        console.log("[DEBUG] Received SDK message, type:", message.type);

        // Emit and store ALL SDK messages (including user messages from the stream)
        await this.eventBus.emit({
          id: crypto.randomUUID(),
          type: "sdk.message",
          sessionId: this.session.id,
          timestamp: new Date().toISOString(),
          data: message,
        });

        // Save to DB (will update if message already exists based on UUID)
        this.db.saveSDKMessage(this.session.id, message);

        // Handle different message types from the Agent SDK
        if (message.type === "assistant") {
          // Full assistant message received
          const apiMessage = message.message;

          // Extract text content
          for (const block of apiMessage.content) {
            if (block.type === "text") {
              assistantContent += block.text;

              // Emit content delta event
              await this.eventBus.emit({
                id: crypto.randomUUID(),
                type: "message.content",
                sessionId: this.session.id,
                timestamp: new Date().toISOString(),
                data: {
                  messageId: assistantMessageId,
                  delta: block.text,
                },
              });
            } else if (block.type === "tool_use") {
              // Tool use detected - use the tool's actual ID from the API
              const toolCall: ToolCall = {
                id: block.id,  // Use the tool_use block's ID from Claude API
                messageId: assistantMessageId,
                tool: block.name,
                input: block.input,
                status: "pending",
                timestamp: new Date().toISOString(),
              };
              toolCalls.push(toolCall);

              // Emit tool call event
              await this.eventBus.emit({
                id: crypto.randomUUID(),
                type: "tool.call",
                sessionId: this.session.id,
                timestamp: new Date().toISOString(),
                data: toolCall,
              });
            }
          }
        } else if (message.type === "stream_event") {
          // Partial assistant message (streaming)
          // Handle raw stream events from the API
          const event = message.event;
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              const delta = event.delta.text;
              assistantContent += delta;

              // Emit content delta event
              await this.eventBus.emit({
                id: crypto.randomUUID(),
                type: "message.content",
                sessionId: this.session.id,
                timestamp: new Date().toISOString(),
                data: {
                  messageId: assistantMessageId,
                  delta,
                },
              });
            }
          }
        } else if (message.type === "result") {
          // Final result message with usage stats
          // We can emit this as a context.updated event
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
              modelUsage: message.modelUsage, // Include per-model usage data with context window info
              costUSD: message.total_cost_usd,
              durationMs: message.duration_ms,
            },
          });
        } else if (message.type === "system" && message.subtype === "status") {
          // Status message (compacting, etc.)
          if (message.status === "compacting") {
            await this.eventBus.emit({
              id: crypto.randomUUID(),
              type: "agent.thinking",
              sessionId: this.session.id,
              timestamp: new Date().toISOString(),
              data: {
                thinking: true,
              },
            });
          }
        }
      }

      console.log("[DEBUG] SDK stream processing complete");

      // Build assistant message for conversation history
      const assistantMessage: Message = {
        id: assistantMessageId,
        sessionId: this.session.id,
        role: "assistant",
        content: assistantContent,
        timestamp: new Date().toISOString(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      // Add to conversation history for SDK prompt building
      // Note: Already saved to sdk_messages table during stream processing
      this.conversationHistory.push(assistantMessage);

      // Emit message complete event
      await this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "message.complete",
        sessionId: this.session.id,
        timestamp: new Date().toISOString(),
        data: {
          messageId: assistantMessageId,
          message: assistantMessage,
        },
      });

      // Update session last active time
      this.session.lastActiveAt = new Date().toISOString();
      this.session.metadata = {
        ...this.session.metadata,
        messageCount: (this.session.metadata?.messageCount || 0) + 2, // user + assistant
      };
      this.db.updateSession(this.session.id, {
        lastActiveAt: this.session.lastActiveAt,
        metadata: this.session.metadata,
      });

      return messageId;
    } catch (error) {
      console.error("Error in sendMessage:", error);

      // Note: Environment variables are already captured at the start of the try block
      // They will be restored here if needed, but we can't access them from outer scope
      // This is okay since each sendMessage call manages its own env state

      // Emit error event
      await this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "error",
        sessionId: this.session.id,
        timestamp: new Date().toISOString(),
        data: {
          error: error instanceof Error ? error.message : String(error),
          messageId,
        },
      });

      throw error;
    }
  }

  /**
   * Build conversation prompt from history
   * The Agent SDK accepts a simple string prompt, so we need to format
   * the conversation history into a readable format
   */
  private buildConversationPrompt(newMessage: string): string {
    if (this.conversationHistory.length === 0) {
      return newMessage;
    }

    // Format previous conversation
    let prompt = "Previous conversation:\n\n";
    for (const msg of this.conversationHistory) {
      if (msg.role === "user") {
        prompt += `User: ${msg.content}\n\n`;
      } else if (msg.role === "assistant") {
        prompt += `Assistant: ${msg.content}\n\n`;
      }
    }

    prompt += `User: ${newMessage}`;
    return prompt;
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
   * Abort current query
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
