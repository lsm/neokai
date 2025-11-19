import { useEffect, useRef, useState } from "preact/hooks";
import type { Event, Message, Session, ToolCall } from "@liuboer/shared";
import { apiClient } from "../lib/api-client.ts";
import { wsClient } from "../lib/websocket-client.ts";
import { toast } from "../lib/toast.ts";
import MessageList from "../components/MessageList.tsx";
import MessageInput from "../components/MessageInput.tsx";
import { Button } from "../components/ui/Button.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { Dropdown } from "../components/ui/Dropdown.tsx";
import { Modal } from "../components/ui/Modal.tsx";
import { Skeleton, SkeletonMessage } from "../components/ui/Skeleton.tsx";

interface ChatContainerProps {
  sessionId: string;
}

export default function ChatContainer({ sessionId }: ChatContainerProps) {
  console.log("ChatContainer rendering with sessionId:", sessionId);

  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCall[]>([]);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSession();
    connectWebSocket();

    return () => {
      wsClient.disconnect();
    };
  }, [sessionId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent]);

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
      setMessages(response.messages);
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

    // Message streaming events
    wsClient.on("message.start", (event: Event) => {
      console.log("Message streaming started");
      setStreamingContent("");
      setStreamingThinking("");
      setStreamingToolCalls([]);
    });

    wsClient.on("message.content", (event: Event) => {
      const delta = (event.data as { delta: string }).delta;
      setStreamingContent((prev) => prev + delta);
    });

    wsClient.on("message.complete", (event: Event) => {
      const message = (event.data as { message: Message }).message;
      setMessages((prev) => [...prev, message]);
      setStreamingContent("");
      setStreamingThinking("");
      setStreamingToolCalls([]);
      setSending(false);
    });

    // Thinking events
    wsClient.on("agent.thinking", (event: Event) => {
      const thinking = (event.data as { thinking: string }).thinking;
      setStreamingThinking(thinking);
    });

    // Tool call events
    wsClient.on("tool.call", (event: Event) => {
      const toolCall = (event.data as { toolCall: ToolCall }).toolCall;
      setStreamingToolCalls((prev) => [...prev, toolCall]);
      toast.info(`Calling tool: ${toolCall.tool}`);
    });

    wsClient.on("tool.result", (event: Event) => {
      const { toolCallId, output, error: toolError } = event.data as {
        toolCallId: string;
        output?: unknown;
        error?: string;
      };
      setStreamingToolCalls((prev) =>
        prev.map((tc) =>
          tc.id === toolCallId
            ? {
                ...tc,
                output,
                error: toolError,
                status: toolError ? "error" : "success",
              } as ToolCall
            : tc
        )
      );
      if (toolError) {
        toast.error(`Tool error: ${toolError}`);
      }
    });

    // Context events
    wsClient.on("context.updated", (event: Event) => {
      const { tokenCount } = event.data as { tokenCount: number };
      console.log(`Context updated: ${tokenCount} tokens`);
    });

    wsClient.on("context.compacted", (event: Event) => {
      const { before, after } = event.data as { before: number; after: number };
      toast.info(`Context compacted: ${before} → ${after} tokens`);
    });

    // Error handling
    wsClient.on("error", (event: Event) => {
      const error = (event.data as { error: string }).error;
      setError(error);
      toast.error(error);
      setSending(false);
      setStreamingContent("");
      setStreamingThinking("");
      setStreamingToolCalls([]);
    });
  };

  const handleSendMessage = async (content: string) => {
    if (!content.trim() || sending) return;

    try {
      setSending(true);
      setError(null);

      // Add user message immediately
      const userMessage: Message = {
        id: `temp-${Date.now()}`,
        sessionId,
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Send to API
      await apiClient.sendMessage(sessionId, { content });
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to send message";
      setError(message);
      toast.error(message);
      setSending(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleClearMessages = async () => {
    try {
      await apiClient.clearMessages(sessionId);
      setMessages([]);
      toast.success("Messages cleared");
      setClearModalOpen(false);
      await loadSession(); // Reload to update metadata
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear messages");
    }
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
      label: "Clear Chat",
      onClick: () => setClearModalOpen(true),
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

  return (
    <div class="flex-1 flex flex-col bg-dark-900 overflow-x-hidden">
      {/* Header */}
      <div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4">
        <div class="max-w-4xl mx-auto w-full pl-16 pr-4 md:px-0 flex items-center justify-between">
          <div>
            <h2 class="text-lg font-semibold text-gray-100">
              {session?.title || "New Session"}
            </h2>
            <div class="flex items-center gap-4 mt-1 text-xs text-gray-400">
              <span class="flex items-center gap-1">
                <svg
                  class="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                  />
                </svg>
                {session?.metadata.messageCount || 0} messages
              </span>
              <span class="flex items-center gap-1">
                <svg
                  class="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
                  />
                </svg>
                {session?.metadata.totalTokens || 0} tokens
              </span>
            </div>
          </div>

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
        class="flex-1 overflow-y-auto overflow-x-hidden"
      >
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          streamingThinking={streamingThinking}
          streamingToolCalls={streamingToolCalls}
          isStreaming={sending}
        />
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

      {/* Input */}
      <MessageInput onSend={handleSendMessage} disabled={sending} />

      {/* Clear Chat Modal */}
      <Modal
        isOpen={clearModalOpen}
        onClose={() => setClearModalOpen(false)}
        title="Clear Chat"
        size="sm"
      >
        <div class="space-y-4">
          <p class="text-gray-300 text-sm">
            Are you sure you want to clear all messages in this chat? This action cannot be undone.
          </p>
          <div class="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setClearModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleClearMessages}>
              Clear Messages
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
