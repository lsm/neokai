/**
 * SDKStreamingMessage Component
 *
 * Renders streaming assistant messages as they arrive in real-time
 * Handles partial message updates from stream_event messages
 */

import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import MarkdownRenderer from "../chat/MarkdownRenderer.tsx";

type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>;

interface Props {
  message: StreamEvent;
}

export function SDKStreamingMessage({ message }: Props) {
  const { event } = message;

  // Accumulate content from stream events
  const getStreamingContent = (): string => {
    // Handle different stream event types
    switch (event.type) {
      case "content_block_start":
        return "";
      case "content_block_delta":
        if (event.delta?.type === "text_delta") {
          return event.delta.text || "";
        }
        if (event.delta?.type === "input_json_delta") {
          return event.delta.partial_json || "";
        }
        return "";
      case "content_block_stop":
        return "";
      default:
        return "";
    }
  };

  const streamingContent = getStreamingContent();

  // Don't render if there's no content
  if (!streamingContent) {
    return null;
  }

  return (
    <div class="group flex items-start gap-3 md:gap-4 p-4 md:p-6 bg-dark-900/30 animate-fadeIn">
      {/* Avatar */}
      <div class="flex-shrink-0">
        <div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center text-white text-sm font-semibold">
          🤖
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 min-w-0 overflow-hidden">
        <div class="mb-2">
          <span class="font-semibold text-sm text-gray-100">Claude</span>
        </div>

        {/* Streaming content */}
        <div class="prose text-gray-200 max-w-full prose-pre:bg-gray-900 prose-pre:text-gray-100">
          <MarkdownRenderer content={streamingContent} />
          <span class="inline-block w-1.5 h-4 bg-purple-500 ml-1 animate-pulse rounded-sm" />
        </div>
      </div>
    </div>
  );
}

/**
 * StreamingAccumulator Component
 *
 * Accumulates multiple stream events into a single displayed message
 * This is useful when you want to show all accumulated content, not just deltas
 */
interface AccumulatorProps {
  events: StreamEvent[];
}

export function SDKStreamingAccumulator({ events }: AccumulatorProps) {
  // Accumulate all text content from stream events
  const accumulatedContent = events.reduce((acc, msg) => {
    const { event } = msg;

    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta") {
        return acc + (event.delta.text || "");
      }
    }

    return acc;
  }, "");

  // Track if we're currently in a thinking block
  const hasThinking = events.some(msg =>
    msg.event.type === "content_block_start" &&
    msg.event.content_block?.type === "thinking"
  );

  if (!accumulatedContent && !hasThinking) {
    return (
      <div class="group flex items-start gap-3 md:gap-4 p-4 md:p-6 bg-dark-900/30 animate-fadeIn">
        <div class="flex-shrink-0">
          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center text-white text-sm font-semibold">
            🤖
          </div>
        </div>
        <div class="flex-1 min-w-0 overflow-hidden">
          <div class="mb-2">
            <span class="font-semibold text-sm text-gray-100">Claude</span>
          </div>
          <div class="flex items-center gap-2 text-gray-400">
            <div class="w-2 h-2 bg-purple-500 rounded-full animate-pulse"></div>
            <span class="text-sm">Thinking...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="group flex items-start gap-3 md:gap-4 p-4 md:p-6 bg-dark-900/30 animate-fadeIn">
      {/* Avatar */}
      <div class="flex-shrink-0">
        <div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center text-white text-sm font-semibold">
          🤖
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 min-w-0 overflow-hidden">
        <div class="mb-2">
          <span class="font-semibold text-sm text-gray-100">Claude</span>
        </div>

        {/* Thinking indicator */}
        {hasThinking && (
          <div class="mb-3 bg-dark-850/50 rounded-lg px-4 py-2">
            <div class="flex items-center gap-2 text-sm text-gray-400 mb-2">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                />
              </svg>
              <span class="font-medium">Thinking</span>
              <div class="ml-auto w-2 h-2 bg-purple-500 rounded-full animate-pulse"></div>
            </div>
          </div>
        )}

        {/* Accumulated streaming content */}
        {accumulatedContent && (
          <div class="prose text-gray-200 max-w-full prose-pre:bg-gray-900 prose-pre:text-gray-100">
            <MarkdownRenderer content={accumulatedContent} />
            <span class="inline-block w-1.5 h-4 bg-purple-500 ml-1 animate-pulse rounded-sm" />
          </div>
        )}
      </div>
    </div>
  );
}
