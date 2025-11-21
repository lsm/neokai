import { useEffect, useRef, useState } from "preact/hooks";
import type { Event, Session } from "@liuboer/shared";
import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import { isSDKStreamEvent } from "@liuboer/shared/sdk/type-guards";
import { apiClient } from "../lib/api-client.ts";
import { wsClient } from "../lib/websocket-client.ts";
import { toast } from "../lib/toast.ts";
import { currentSessionIdSignal, sessionsSignal, sidebarOpenSignal } from "../lib/signals.ts";
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
  const [contextUsage, setContextUsage] = useState<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSession();
    const cleanupHandlers = connectWebSocket();

    return () => {
      wsClient.disconnect();
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

      // Calculate initial context usage from existing messages
      // Total input tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
      // Find the last result message with success status to get the most up-to-date usage
      // The SDK returns cumulative usage in each result message, so we shouldn't sum them up
      const lastResultMessage = [...sdkResponse.sdkMessages].reverse().find(
        msg => msg.type === 'result' && msg.subtype === 'success'
      );

      const initialUsage = lastResultMessage && lastResultMessage.type === 'result' && lastResultMessage.subtype === 'success'
        ? {
            inputTokens: lastResultMessage.usage.input_tokens,
            outputTokens: lastResultMessage.usage.output_tokens,
            cacheReadTokens: lastResultMessage.usage.cache_read_input_tokens || 0,
            cacheCreationTokens: lastResultMessage.usage.cache_creation_input_tokens || 0
          }
        : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      setContextUsage(initialUsage);
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to load session";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const connectWebSocket = () => {
    wsClient.connect(sessionId);
    setIsWsConnected(true);

    // SDK message events - PRIMARY EVENT HANDLER
    const unsubSDKMessage = wsClient.on("sdk.message", (event: Event) => {
      const sdkMessage = event.data as SDKMessage;
      console.log("Received SDK message:", sdkMessage.type, sdkMessage);

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
    });

    // Context events
    const unsubContextUpdated = wsClient.on("context.updated", (event: Event) => {
      const data = event.data as { tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }; costUSD: number; durationMs: number };
      console.log(`Context updated:`, data);

      // Update context usage with the latest values
      // The event contains the usage for the current turn, which represents the full context window size
      setContextUsage({
        inputTokens: data.tokenUsage.inputTokens,
        outputTokens: data.tokenUsage.outputTokens,
        cacheReadTokens: data.tokenUsage.cacheReadTokens,
        cacheCreationTokens: data.tokenUsage.cacheCreationTokens,
      });
    });

    const unsubContextCompacted = wsClient.on("context.compacted", (event: Event) => {
      const { before, after } = event.data as { before: number; after: number };
      toast.info(`Context compacted: ${before} → ${after} tokens`);
    });

    // Error handling
    const unsubError = wsClient.on("error", (event: Event) => {
      const error = (event.data as { error: string }).error;
      setError(error);
      toast.error(error);
      setSending(false);
      setStreamingEvents([]);
      setCurrentAction(undefined);
      setIsWsConnected(false);
    });

    // Connection status tracking with reconciliation
    const unsubConnect = wsClient.on("connect", async () => {
      setIsWsConnected(true);

      // Reconcile missed messages on reconnect
      try {
        // Use setMessages with updater function to get current state
        let lastTimestamp = 0;
        setMessages((currentMessages) => {
          // Calculate the timestamp of the last message we have
          if (currentMessages.length > 0) {
            lastTimestamp = Math.max(...currentMessages.map(m => m.timestamp));
          }
          return currentMessages; // Don't modify state here
        });

        // Fetch any messages we missed while disconnected
        if (lastTimestamp > 0) {
          const response = await apiClient.getSDKMessages(sessionId, {
            since: lastTimestamp,
          });

          if (response.sdkMessages.length > 0) {
            console.log(`Reconciled ${response.sdkMessages.length} missed messages`);

            // Merge with existing messages, deduplicating by UUID
            setMessages((prev) => {
              const merged = [...prev, ...response.sdkMessages];
              // Deduplicate by UUID
              const uniqueMap = new Map(merged.map(m => [m.uuid, m]));
              return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
            });
          }
        }
      } catch (error) {
        console.error("Failed to reconcile messages on reconnect:", error);
        // Don't show error to user - connection is still established
      }
    });

    const unsubDisconnect = wsClient.on("disconnect", () => {
      setIsWsConnected(false);
    });

    // Return cleanup function that unsubscribes all handlers
    return () => {
      unsubSDKMessage();
      unsubContextUpdated();
      unsubContextCompacted();
      unsubError();
      unsubConnect();
      unsubDisconnect();
    };
  };

  const handleSendMessage = async (content: string) => {
    if (!content.trim() || sending) return;

    try {
      setSending(true);
      setError(null);
      setCurrentAction("Processing...");

      // Send to API - WebSocket will add the message when daemon confirms
      // No optimistic update to avoid duplicates
      await apiClient.sendMessage(sessionId, { content });
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
        if (messages[j].type === 'user') {
          sessionInfoMap.set(messages[j].uuid, msg);
          break;
        }
      }
      // If no preceding user message, attach to the first user message after this session init
      if (!sessionInfoMap.has(msg.uuid)) {
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].type === 'user') {
            sessionInfoMap.set(messages[j].uuid, msg);
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
                sessionInfo={sessionInfoMap.get(msg.uuid)}
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
