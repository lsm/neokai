/**
 * Message Persistence Module
 *
 * Handles user message persistence to database and UI broadcasting:
 * - Expand built-in commands
 * - Build message content (text + images)
 * - Create SDK user message format
 * - Save to database
 * - Publish to UI via state channels
 * - Emit events for downstream processing
 */

import type { MessageContent, MessageHub, MessageImage } from "@liuboer/shared";
import type { SDKUserMessage } from "@liuboer/shared/sdk";
import type { UUID } from "crypto";
import type { Database } from "../../storage/database";
import type { DaemonHub } from "../daemon-hub";
import { expandBuiltInCommand } from "../built-in-commands";
import { Logger } from "../logger";
import type { SessionCache } from "./session-cache";

export interface MessagePersistenceData {
  sessionId: string;
  messageId: string;
  content: string;
  images?: MessageImage[];
}

export class MessagePersistence {
  private logger: Logger;

  constructor(
    private sessionCache: SessionCache,
    private db: Database,
    private messageHub: MessageHub,
    private eventBus: DaemonHub,
  ) {
    this.logger = new Logger("MessagePersistence");
  }

  /**
   * Handle message persistence
   *
   * ARCHITECTURE: EventBus-centric - SessionManager owns message persistence logic
   *
   * Responsibilities:
   * 1. Expand built-in commands
   * 2. Build message content (text + images)
   * 3. Create SDK user message
   * 4. Save to database
   * 5. Publish to UI via state channel
   * 6. Emit 'message.persisted' event for downstream processing
   */
  async persist(data: MessagePersistenceData): Promise<void> {
    const { sessionId, messageId, content, images } = data;

    const agentSession = await this.sessionCache.getAsync(sessionId);
    if (!agentSession) {
      const error = `[MessagePersistence] Session ${sessionId} not found for message persistence`;
      this.logger.error(error);
      // FIX: Throw instead of returning early so error is propagated
      // This prevents messages from being silently lost when session fails to load
      throw new Error(error);
    }

    const session = agentSession.getSessionData();

    try {
      // 1. Expand built-in commands (e.g., /merge-session → full prompt)
      const expandedContent = expandBuiltInCommand(content);
      const finalContent = expandedContent || content;

      if (expandedContent) {
        this.logger.info(
          `[MessagePersistence] Expanding built-in command: ${content.trim()}`,
        );
      }

      // 2. Build message content (text + images)
      const messageContent = buildMessageContent(finalContent, images);

      // 3. Create SDK user message
      const sdkUserMessage: SDKUserMessage = {
        type: "user" as const,
        uuid: messageId as UUID,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: "user" as const,
          content:
            typeof messageContent === "string"
              ? [{ type: "text" as const, text: messageContent }]
              : messageContent,
        },
      };

      // 4. Save to database
      this.db.saveSDKMessage(sessionId, sdkUserMessage);

      // 5. Publish to UI (fire-and-forget)
      this.messageHub
        .publish(
          "state.sdkMessages.delta",
          { added: [sdkUserMessage], timestamp: Date.now() },
          { sessionId },
        )
        .catch((err) => {
          this.logger.error(
            "[MessagePersistence] Error publishing message to UI:",
            err,
          );
        });

      this.logger.info(
        `[MessagePersistence] User message ${messageId} persisted and published to UI`,
      );

      // 6. Emit 'message.persisted' event for downstream processing
      // AgentSession will start query and enqueue message
      // SessionManager will handle title generation and draft clearing
      await this.eventBus.emit("message.persisted", {
        sessionId,
        messageId,
        messageContent,
        userMessageText: content, // Original content (before expansion)
        needsWorkspaceInit: !session.metadata.titleGenerated,
        hasDraftToClear: session.metadata?.inputDraft === content.trim(),
      });
    } catch (error) {
      this.logger.error(
        "[MessagePersistence] Error persisting message:",
        error,
      );
      throw error;
    }
  }
}

/**
 * Build message content from text and optional images
 * Static utility function for building SDK message content
 */
export function buildMessageContent(
  content: string,
  images?: MessageImage[],
): string | MessageContent[] {
  if (!images || images.length === 0) {
    return content;
  }

  // Multi-modal message: array of content blocks
  // Images first, then text (SDK format)
  return [
    ...images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.media_type,
        data: img.data,
      },
    })),
    { type: "text" as const, text: content },
  ];
}
