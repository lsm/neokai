import { useState } from "preact/hooks";
import type { Message } from "@liuboer/shared";
import { Collapsible } from "./ui/Collapsible.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { Dropdown, type DropdownMenuItem } from "./ui/Dropdown.tsx";
import { Tooltip } from "./ui/Tooltip.tsx";
import MarkdownRenderer from "./chat/MarkdownRenderer.tsx";
import CodeBlock from "./chat/CodeBlock.tsx";
import { copyToClipboard, formatDuration } from "../lib/utils.ts";
import { toast } from "../lib/toast.ts";
import { cn } from "../lib/utils.ts";

interface MessageItemProps {
  message: Message;
  onRegenerate?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

export default function MessageItem({
  message,
  onRegenerate,
  onEdit,
  onDelete,
}: MessageItemProps) {
  const isUser = message.role === "user";
  const [showActions, setShowActions] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(message.content);
    if (success) {
      toast.success("Message copied to clipboard");
    } else {
      toast.error("Failed to copy message");
    }
  };

  const getMessageActions = (): DropdownMenuItem[] => {
    const actions: DropdownMenuItem[] = [
      {
        label: "Copy text",
        onClick: handleCopy,
        icon: (
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        ),
      },
    ];

    if (!isUser && onRegenerate) {
      actions.push({
        label: "Regenerate",
        onClick: async () => { onRegenerate(); },
        icon: (
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        ),
      });
    }

    if (onEdit) {
      actions.push({
        label: "Edit",
        onClick: async () => { onEdit(); },
        icon: (
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        ),
      });
    }

    if (onDelete) {
      actions.push({ type: "divider" });
      actions.push({
        label: "Delete",
        onClick: async () => { onDelete(); },
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
      });
    }

    return actions;
  };

  return (
    <div
      class={cn(
        "group flex items-start gap-3 md:gap-4 p-4 md:p-6 transition-colors",
        isUser ? "bg-dark-850/30" : "bg-dark-900/30",
      )}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Avatar */}
      <div class="flex-shrink-0">
        <div
          class={cn(
            "w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold",
            isUser
              ? "bg-gradient-to-br from-blue-500 to-blue-600"
              : "bg-gradient-to-br from-purple-500 to-purple-600",
          )}
        >
          {isUser ? "👤" : "🤖"}
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 min-w-0 overflow-hidden">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-sm text-gray-100">
              {isUser ? "You" : "Claude"}
            </span>
            <Tooltip
              content={new Date(message.timestamp).toLocaleString()}
              position="right"
            >
              <span class="text-xs text-gray-500">
                {new Date(message.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </Tooltip>
          </div>

          {/* Actions */}
          <div
            class={cn(
              "flex items-center gap-1 transition-opacity",
              showActions ? "opacity-100" : "opacity-0",
            )}
          >
            <IconButton size="sm" onClick={handleCopy} title="Copy message">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </IconButton>

            <Dropdown
              trigger={
                <IconButton size="sm" title="More actions">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                  </svg>
                </IconButton>
              }
              items={getMessageActions()}
            />
          </div>
        </div>

        {/* Thinking */}
        {message.thinking && (
          <div class="mb-3">
            <Collapsible
              trigger={
                <div class="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-300 transition-colors py-1">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                  <span class="font-medium">Thinking</span>
                </div>
              }
              class="bg-dark-850/50 rounded-lg px-4 py-2"
            >
              <div class="text-sm text-gray-300 whitespace-pre-wrap mt-2">
                {message.thinking}
              </div>
            </Collapsible>
          </div>
        )}

        {/* Main Content */}
        {message.content && (
          <div class="text-gray-200 max-w-full">
            <MarkdownRenderer content={message.content} />
          </div>
        )}

        {/* Tool Calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div class="mt-4 space-y-2">
            {message.toolCalls.map((toolCall) => (
              <Collapsible
                key={toolCall.id}
                trigger={
                  <div class="flex items-center gap-2 text-sm py-1">
                    <span
                      class={cn(
                        "w-2 h-2 rounded-full",
                        toolCall.status === "success"
                          ? "bg-green-500"
                          : toolCall.status === "error"
                          ? "bg-red-500"
                          : "bg-yellow-500",
                      )}
                    />
                    <span class="font-medium text-gray-300">
                      {toolCall.tool}
                    </span>
                    {toolCall.duration && (
                      <span class="text-gray-500 text-xs">
                        ({formatDuration(toolCall.duration)})
                      </span>
                    )}
                  </div>
                }
                class="bg-dark-850/50 rounded-lg px-4 py-2"
              >
                <div class="mt-2 space-y-3 text-sm">
                  <div>
                    <div class="text-xs font-medium text-gray-400 mb-1">
                      Input
                    </div>
                    <pre class="text-xs bg-dark-900 text-gray-300 p-3 rounded overflow-x-auto">
                      {JSON.stringify(toolCall.input, null, 2)}
                    </pre>
                  </div>
                  {toolCall.output && (
                    <div>
                      <div class="text-xs font-medium text-gray-400 mb-1">
                        Output
                      </div>
                      <pre class="text-xs bg-dark-900 text-gray-300 p-3 rounded overflow-x-auto max-h-60">
                        {JSON.stringify(toolCall.output, null, 2)}
                      </pre>
                    </div>
                  )}
                  {toolCall.error && (
                    <div class="text-xs text-red-400 bg-red-500/10 p-2 rounded">
                      Error: {toolCall.error}
                    </div>
                  )}
                </div>
              </Collapsible>
            ))}
          </div>
        )}

        {/* Artifacts */}
        {message.artifacts && message.artifacts.length > 0 && (
          <div class="mt-4 space-y-3">
            {message.artifacts.map((artifact) => (
              <CodeBlock
                key={artifact.id}
                code={artifact.content}
                filename={artifact.title}
                language={artifact.language}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
