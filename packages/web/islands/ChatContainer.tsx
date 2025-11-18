import { useEffect, useRef, useState } from "preact/hooks";
import type { Event, Message, Session } from "@liuboer/shared";
import { apiClient } from "../lib/api-client.ts";
import { wsClient } from "../lib/websocket-client.ts";
import MessageList from "../components/MessageList.tsx";
import MessageInput from "../components/MessageInput.tsx";

interface ChatContainerProps {
  sessionId: string;
}

export default function ChatContainer({ sessionId }: ChatContainerProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  const loadSession = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.getSession(sessionId);
      setSession(response.session);
      setMessages(response.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session");
    } finally {
      setLoading(false);
    }
  };

  const connectWebSocket = () => {
    wsClient.connect(sessionId);

    wsClient.on("message.content", (event: Event) => {
      const delta = (event.data as { delta: string }).delta;
      setStreamingContent((prev) => prev + delta);
    });

    wsClient.on("message.complete", (event: Event) => {
      const message = (event.data as { message: Message }).message;
      setMessages((prev) => [...prev, message]);
      setStreamingContent("");
      setSending(false);
    });

    wsClient.on("error", (event: Event) => {
      const error = (event.data as { error: string }).error;
      setError(error);
      setSending(false);
      setStreamingContent("");
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
      setError(err instanceof Error ? err.message : "Failed to send message");
      setSending(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  if (loading) {
    return (
      <div class="flex-1 flex items-center justify-center bg-gray-50">
        <div class="text-gray-500">Loading session...</div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div class="flex-1 flex items-center justify-center bg-gray-50">
        <div class="text-red-500">{error}</div>
      </div>
    );
  }

  return (
    <div class="flex-1 flex flex-col bg-gray-50">
      {/* Header */}
      <div class="bg-white border-b border-gray-200 p-4">
        <h2 class="text-lg font-semibold text-gray-900">
          {session?.title || "New Session"}
        </h2>
        <p class="text-sm text-gray-500 mt-1">
          {session?.metadata.messageCount || 0} messages • {session?.metadata.totalTokens || 0}{" "}
          tokens
        </p>
      </div>

      {/* Messages */}
      <div class="flex-1 overflow-y-auto">
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          isStreaming={sending}
        />
        <div ref={messagesEndRef} />
      </div>

      {/* Error Banner */}
      {error && (
        <div class="bg-red-50 border-t border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Input */}
      <MessageInput onSend={handleSendMessage} disabled={sending} />
    </div>
  );
}
