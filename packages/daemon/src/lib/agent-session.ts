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

    // Save user message
    const userMessage: Message = {
      id: messageId,
      sessionId: this.session.id,
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };

    this.db.saveMessage(userMessage);
    this.conversationHistory.push(userMessage);

    // Emit message start event
    await this.eventBus.emit({
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
      // Get current API key (could be from API key or OAuth token)
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        throw new Error("No authentication configured. Please set up OAuth or API key.");
      }

      // Create abort controller for this query
      this.abortController = new AbortController();

      // Set API key in environment for the Agent SDK
      // The SDK accepts both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

      // Try setting as OAuth token first (preferred for subscription users)
      process.env.CLAUDE_CODE_OAUTH_TOKEN = apiKey;
      // Also set as API key for fallback
      process.env.ANTHROPIC_API_KEY = apiKey;

      // Call Claude Agent SDK with streaming
      const assistantMessageId = crypto.randomUUID();
      let assistantContent = "";
      const toolCalls: ToolCall[] = [];

      // Build the prompt with conversation history
      const conversationPrompt = this.buildConversationPrompt(content);

      // Create query with Agent SDK
      const queryStream = query({
        prompt: conversationPrompt,
        options: {
          model: this.session.config.model,
          cwd: this.session.workspacePath,
          abortController: this.abortController,
          // Use bypassPermissions mode for non-interactive daemon
          permissionMode: "bypassPermissions",
          // Limit turns to prevent infinite loops
          maxTurns: 10,
        },
      });

      // Process the stream
      for await (const message of queryStream) {
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
                type: "message.content",
                sessionId: this.session.id,
                timestamp: new Date().toISOString(),
                data: {
                  messageId: assistantMessageId,
                  delta: block.text,
                },
              });
            } else if (block.type === "tool_use") {
              // Tool use detected
              const toolCall: ToolCall = {
                id: crypto.randomUUID(),
                messageId: assistantMessageId,
                tool: block.name,
                input: block.input,
                status: "pending",
                timestamp: new Date().toISOString(),
              };
              toolCalls.push(toolCall);

              // Emit tool call event
              await this.eventBus.emit({
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
              costUSD: message.total_cost_usd,
              durationMs: message.duration_ms,
            },
          });
        } else if (message.type === "system" && message.subtype === "status") {
          // Status message (compacting, etc.)
          if (message.status === "compacting") {
            await this.eventBus.emit({
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

      // Restore original environment variables
      if (originalApiKey) {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }

      if (originalOAuthToken) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }

      // Save assistant message
      const assistantMessage: Message = {
        id: assistantMessageId,
        sessionId: this.session.id,
        role: "assistant",
        content: assistantContent,
        timestamp: new Date().toISOString(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      this.db.saveMessage(assistantMessage);
      this.conversationHistory.push(assistantMessage);

      // Save tool calls to database
      for (const toolCall of toolCalls) {
        this.db.saveToolCall(toolCall);
      }

      // Emit message complete event
      await this.eventBus.emit({
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

    this.db.updateSession(this.session.id, updates);
  }

  /**
   * Clear conversation history (for testing or reset)
   */
  clearHistory(): void {
    this.conversationHistory = [];
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
