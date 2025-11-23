import { useEffect, useRef, useState } from "preact/hooks";
import type { Session, ContextInfo } from "@liuboer/shared";
import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import { isSDKStreamEvent } from "@liuboer/shared/sdk/type-guards";
import { messageHubApiClient as apiClient } from "../lib/messagehub-api-client.ts";
import { toast } from "../lib/toast.ts";
import { generateUUID } from "../lib/utils.ts";
import { currentSessionIdSignal, sessionsSignal, sidebarOpenSignal, slashCommandsSignal } from "../lib/signals.ts";
import MessageInput from "../components/MessageInput.tsx";
import StatusIndicator from "../components/StatusIndicator.tsx";
import { Button } from "../components/ui/Button.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { Dropdown } from "../components/ui/Dropdown.tsx";
import { Modal } from "../components/ui/Modal.tsx";
import { Skeleton, SkeletonMessage } from "../components/ui/Skeleton.tsx";
import { SDKMessageRenderer } from "../components/sdk/SDKMessageRenderer.tsx";
import { SDKStreamingAccumulator } from "../components/sdk/SDKStreamingMessage.tsx";
import { getCurrentAction } from "../lib/status-actions.ts";

interface ChatContainerProps {
  sessionId: string;
}

export default function ChatContainer({ sessionId }: ChatContainerProps) {
  console.log("ChatContainer rendering with sessionId:", sessionId);

  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<SDKMessage[]>([]);
  const [streamingEvents, setStreamingEvents] = useState<Extract<SDKMessage, { type: "stream_event" }>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [currentAction, setCurrentAction] = useState<string | undefined>(undefined);

  /**
   * Context usage from accurate SDK context info
   */
  const [contextUsage, setContextUsage] = useState<ContextInfo | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSession();
    const cleanupHandlers = connectWebSocket();

    return () => {
      // Don't disconnect here - let the next ChatContainer's useEffect handle session switching
      // eventBusClient manages session switching internally in its connect() method
      cleanupHandlers();
    };
  }, [sessionId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingEvents]);

  // Detect scroll position
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 200;
      setShowScrollButton(!isNearBottom);
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const loadSession = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.getSession(sessionId);
      setSession(response.session);

      // Load SDK messages
      const sdkResponse = await apiClient.getSDKMessages(sessionId);
      setMessages(sdkResponse.sdkMessages);

      // Load slash commands for this session
      try {
        const commandsResponse = await apiClient.getSlashCommands(sessionId);
        if (commandsResponse.commands && commandsResponse.commands.length > 0) {
          console.log("Loaded slash commands:", commandsResponse.commands);
          slashCommandsSignal.value = commandsResponse.commands;
        }
      } catch (cmdError) {
        // Slash commands might not be available yet (needs first message)
        console.log("Slash commands not yet available:", cmdError);
      }

      // Context usage will be populated from context.updated events
      // No need to calculate from API response messages
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to load session";

      // Check if this is a session not found error
      // If so, clear the session ID to navigate back to the default page
      if (message.includes("Session not found") || message.includes("404")) {
        console.log("Session not found, clearing session ID and returning to home");
        currentSessionIdSignal.value = null;
        toast.error("Session not found. Returning to sessions list.");
        return; // Don't set error state, just clear and return
      }

      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const connectWebSocket = () => {
    // Subscribe to session-specific events via MessageHub
    setIsWsConnected(true); // MessageHub is already connected from apiClient

    // SDK message events - PRIMARY EVENT HANDLER
    const unsubSDKMessage = apiClient.subscribe<SDKMessage>(
      'sdk.message',
      (sdkMessage) => {
        console.log("Received SDK message:", sdkMessage.type, sdkMessage);

        // Extract slash commands from SDK init message
        if (sdkMessage.type === "system" && sdkMessage.subtype === "init") {
          const initMessage = sdkMessage as any;
          if (initMessage.slash_commands && Array.isArray(initMessage.slash_commands)) {
            console.log("Extracted slash commands from SDK:", initMessage.slash_commands);
            slashCommandsSignal.value = initMessage.slash_commands;
          }
        }

        // Update current action based on this message
        // We're processing if: sending is true OR we have streaming events OR we haven't received final result yet
        const isProcessing = sending || streamingEvents.length > 0 || sdkMessage.type !== "result";
        const action = getCurrentAction(sdkMessage, isProcessing);
        if (action) {
          setCurrentAction(action);
        }

        // Handle stream events separately for real-time display
        if (isSDKStreamEvent(sdkMessage)) {
          setStreamingEvents((prev) => [...prev, sdkMessage]);
        } else {
          // Only clear processing state when we get the FINAL result message with token usage
          if (sdkMessage.type === "result" && sdkMessage.subtype === "success") {
            setStreamingEvents([]);
            setSending(false);
            setCurrentAction(undefined);
          }
          // Add non-stream messages to main array, deduplicating by uuid
          setMessages((prev) => {
            // If message has a uuid, check if it already exists (from optimistic update)
            if (sdkMessage.uuid) {
              const existingIndex = prev.findIndex(m => m.uuid === sdkMessage.uuid);
              if (existingIndex !== -1) {
                // Replace optimistic message with confirmed one
                const updated = [...prev];
                updated[existingIndex] = sdkMessage;
                return updated;
              }
            }
            // New message, add to end
            return [...prev, sdkMessage];
          });
        }
      },
      { sessionId }
    );

    // Context events
    const unsubContextUpdated = apiClient.subscribe<any>('context.updated', (data) => {
      // data is already the payload
      console.log(`Context updated:`, data);

      // Only handle accurate context info from /context command
      if (data.totalUsed !== undefined) {
        console.log(`Received accurate context info:`, {
          totalUsed: data.totalUsed,
          totalCapacity: data.totalCapacity,
          percentUsed: data.percentUsed,
          breakdown: data.breakdown,
        });

        // Update with accurate SDK context data
        setContextUsage({
          totalUsed: data.totalUsed,
          totalCapacity: data.totalCapacity,
          percentUsed: data.percentUsed,
          breakdown: data.breakdown,
          model: data.model,
          slashCommandTool: data.slashCommandTool,
        });
      }
    }, { sessionId });

    const unsubContextCompacted = apiClient.subscribe<{ before: number; after: number }>('context.compacted', (data) => {
      const { before, after } = data;
      toast.info(`Context compacted: ${before} → ${after} tokens`);
    }, { sessionId });

    // Error handling
    const unsubError = apiClient.subscribe<{ error: string }>('session.error', (data) => {
      const error = data.error;
      setError(error);
      toast.error(error);
      setSending(false);
      setStreamingEvents([]);
      setCurrentAction(undefined);
      setIsWsConnected(false);
    }, { sessionId });

    // Message queue events (streaming input mode)
    const unsubMessageQueued = apiClient.subscribe<{ messageId: string }>('message.queued', (data) => {
      const { messageId } = data;
      console.log("Message queued:", messageId);
      setCurrentAction("Queued...");
    }, { sessionId });

    const unsubMessageProcessing = apiClient.subscribe<{ messageId: string }>('message.processing', (data) => {
      const { messageId } = data;
      console.log("Message processing:", messageId);
      setCurrentAction("Processing...");
    }, { sessionId });

    // Return cleanup function that unsubscribes all handlers
    return () => {
      unsubSDKMessage?.();
      unsubContextUpdated?.();
      unsubContextCompacted?.();
      unsubError?.();
      unsubMessageQueued?.();
      unsubMessageProcessing?.();
    };
  };

  const handleSendMessage = async (content: string) => {
    if (!content.trim() || sending) return;

    // Check if MessageHub is connected
    if (!isWsConnected) {
      toast.error("Connection lost. Please refresh the page.");
      return;
    }

    try {
      setSending(true);
      setError(null);
      setCurrentAction("Sending...");

      // Send via MessageHub pub/sub (streaming input mode!)
      // The daemon will queue the message and yield it to the SDK AsyncGenerator
      await apiClient.getMessageHub()?.publish(
        'message.send',
        {
          content,
          // images: undefined, // Future: support image uploads
        },
        { sessionId }
      );

      // Note: Don't set sending=false here - wait for message.queued or message.processing event
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to send message";
      setError(message);
      toast.error(message);
      setSending(false);
      setCurrentAction(undefined);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleDeleteSession = async () => {
    try {
      await apiClient.deleteSession(sessionId);
      
      // Reload sessions to get the updated list from API
      const response = await apiClient.listSessions();
      sessionsSignal.value = response.sessions;
      
      // Clear current session to redirect to home
      currentSessionIdSignal.value = null;
      
      toast.success("Session deleted");
      setDeleteModalOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete session");
    }
  };

  const handleMenuClick = () => {
    sidebarOpenSignal.value = true;
  };

  const getHeaderActions = () => [
    {
      label: "Session Settings",
      onClick: () => toast.info("Session settings coming soon"),
      icon: (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      ),
    },
    {
      label: "Export Chat",
      onClick: () => toast.info("Export feature coming soon"),
      icon: (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
      ),
    },
    { type: "divider" as const },
    {
      label: "Delete Chat",
      onClick: () => setDeleteModalOpen(true),
      danger: true,
      icon: (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      ),
    },
  ];

  if (loading) {
    return (
      <div class="flex-1 flex flex-col bg-dark-900">
        {/* Header Skeleton */}
        <div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4">
          <Skeleton width="200px" height={24} class="mb-2" />
          <Skeleton width="150px" height={16} />
        </div>

        {/* Messages Skeleton */}
        <div class="flex-1 overflow-y-auto">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonMessage key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div class="flex-1 flex items-center justify-center bg-dark-900">
        <div class="text-center">
          <div class="text-5xl mb-4">⚠️</div>
          <h3 class="text-lg font-semibold text-gray-100 mb-2">
            Failed to load session
          </h3>
          <p class="text-sm text-gray-400 mb-4">{error}</p>
          <Button onClick={loadSession}>Retry</Button>
        </div>
      </div>
    );
  }

  // Calculate accumulated stats from result messages
  const accumulatedStats = messages.reduce((acc, msg) => {
    if (msg.type === 'result' && msg.subtype === 'success') {
      acc.inputTokens += msg.usage.input_tokens;
      acc.outputTokens += msg.usage.output_tokens;
      acc.totalCost += msg.total_cost_usd;
    }
    return acc;
  }, { inputTokens: 0, outputTokens: 0, totalCost: 0 });

  // Create a map of tool use IDs to tool results for easy lookup
  const toolResultsMap = new Map<string, any>();
  messages.forEach((msg) => {
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      msg.message.content.forEach((block: any) => {
        if (block.type === 'tool_result') {
          toolResultsMap.set(block.tool_use_id, block);
        }
      });
    }
  });

  // Create a map of tool use IDs to tool inputs for easy lookup
  const toolInputsMap = new Map<string, any>();
  messages.forEach((msg) => {
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      msg.message.content.forEach((block: any) => {
        if (block.type === 'tool_use') {
          toolInputsMap.set(block.id, block.input);
        }
      });
    }
  });

  // Create a map of user message UUIDs to their attached session init info
  // Session init messages appear after the first user message, so we attach them to the preceding user message
  const sessionInfoMap = new Map<string, any>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type === 'system' && msg.subtype === 'init') {
      // Find the most recent user message before this session init
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].type === 'user' && messages[j].uuid) {
          sessionInfoMap.set(messages[j].uuid!, msg);
          break;
        }
      }
      // If no preceding user message, attach to the first user message after this session init
      if (msg.uuid && !sessionInfoMap.has(msg.uuid)) {
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].type === 'user' && messages[j].uuid) {
            sessionInfoMap.set(messages[j].uuid!, msg);
            break;
          }
        }
      }
    }
  }

  return (
    <div class="flex-1 flex flex-col bg-dark-900 overflow-x-hidden">
      {/* Header */}
      <div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4">
        <div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center gap-3">
          {/* Hamburger menu button - visible only on mobile */}
          <button
            onClick={handleMenuClick}
            class="md:hidden p-2 -ml-2 bg-dark-850 border border-dark-700 rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0"
            title="Open menu"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Session title and stats */}
          <div class="flex-1 min-w-0">
            <h2 class="text-lg font-semibold text-gray-100 truncate">
              {session?.title || "New Session"}
            </h2>
            <div class="flex items-center gap-3 mt-1 text-xs text-gray-400">
              <span class="flex items-center gap-1" title="Input tokens">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
                </svg>
                {accumulatedStats.inputTokens.toLocaleString()}
              </span>
              <span class="flex items-center gap-1" title="Output tokens">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M17 13l-5 5m0 0l-5-5m5 5V6" />
                </svg>
                {accumulatedStats.outputTokens.toLocaleString()}
              </span>
              <span class="text-gray-500">({(accumulatedStats.inputTokens + accumulatedStats.outputTokens).toLocaleString()} total)</span>
              <span class="text-gray-500">•</span>
              <span class="font-mono text-green-400">${accumulatedStats.totalCost.toFixed(4)}</span>
            </div>
          </div>

          {/* Options dropdown */}
          <Dropdown
            trigger={
              <IconButton title="Session options">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                </svg>
              </IconButton>
            }
            items={getHeaderActions()}
          />
        </div>
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        class="flex-1 overflow-y-auto"
      >
        {messages.length === 0 && streamingEvents.length === 0 ? (
          <div class="flex items-center justify-center h-full px-6">
            <div class="text-center">
              <div class="text-5xl mb-4">💬</div>
              <p class="text-lg text-gray-300 mb-2">No messages yet</p>
              <p class="text-sm text-gray-500">
                Start a conversation with Claude to see the magic happen
              </p>
            </div>
          </div>
        ) : (
          <div class="max-w-4xl mx-auto w-full px-4 md:px-6 space-y-0">
            {/* Render all messages using SDK components */}
            {messages.map((msg, idx) => (
              <SDKMessageRenderer
                key={msg.uuid || `msg-${idx}`}
                message={msg}
                toolResultsMap={toolResultsMap}
                toolInputsMap={toolInputsMap}
                sessionInfo={msg.uuid ? sessionInfoMap.get(msg.uuid) : undefined}
              />
            ))}

            {/* Render streaming events if present */}
            {streamingEvents.length > 0 && (
              <SDKStreamingAccumulator events={streamingEvents} />
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to Bottom Button */}
      {showScrollButton && (
        <div class="absolute bottom-28 right-8">
          <IconButton
            onClick={scrollToBottom}
            variant="solid"
            size="lg"
            class="shadow-lg animate-slideIn"
            title="Scroll to bottom"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M19 14l-7 7m0 0l-7-7m7 7V3"
              />
            </svg>
          </IconButton>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div class="bg-red-500/10 border-t border-red-500/20 px-4 py-3">
          <div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center justify-between">
            <p class="text-sm text-red-400">{error}</p>
            <button
              onClick={() => setError(null)}
              class="text-red-400 hover:text-red-300 transition-colors"
            >
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fill-rule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Status Indicator */}
      <StatusIndicator
        isConnected={isWsConnected}
        isProcessing={sending || streamingEvents.length > 0}
        currentAction={currentAction}
        contextUsage={contextUsage}
        maxContextTokens={200000}
        onSendMessage={handleSendMessage}
      />

      {/* Input */}
      <MessageInput onSend={handleSendMessage} disabled={sending} />

      {/* Delete Chat Modal */}
      <Modal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Chat"
        size="sm"
      >
        <div class="space-y-4">
          <p class="text-gray-300 text-sm">
            Are you sure you want to delete this chat session? This action cannot be undone.
          </p>
          <div class="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDeleteSession}>
              Delete Chat
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
