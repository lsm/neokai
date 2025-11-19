/**
 * SDKAssistantMessage Renderer
 *
 * Renders assistant messages with proper content array parsing:
 * - Text blocks (markdown)
 * - Tool use blocks (expandable with input/output)
 * - Thinking blocks (collapsible)
 */

import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import { isTextBlock, isToolUseBlock, isThinkingBlock } from "@liuboer/shared/sdk/type-guards";
import { MarkdownRenderer } from "../chat/MarkdownRenderer.tsx";
import { Collapsible } from "../ui/Collapsible.tsx";
import { useState } from "preact/hooks";

type AssistantMessage = Extract<SDKMessage, { type: "assistant" }>;

interface Props {
  message: AssistantMessage;
}

export function SDKAssistantMessage({ message }: Props) {
  const { message: apiMessage } = message;

  return (
    <div class="flex gap-3 py-4">
      {/* Avatar */}
      <div class="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-semibold text-sm shadow-md">
        AI
      </div>

      {/* Content */}
      <div class="flex-1 space-y-3 min-w-0">
        {apiMessage.content.map((block, idx) => {
          // Text block - render as markdown
          if (isTextBlock(block)) {
            return (
              <div key={idx} class="prose dark:prose-invert max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100">
                <MarkdownRenderer content={block.text} />
              </div>
            );
          }

          // Tool use block - show expandable details
          if (isToolUseBlock(block)) {
            return <ToolUseBlock key={idx} block={block} />;
          }

          // Thinking block - collapsible
          if (isThinkingBlock(block)) {
            return (
              <Collapsible
                key={idx}
                trigger={
                  <div class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer hover:text-gray-800 dark:hover:text-gray-200">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    <span>Thinking...</span>
                  </div>
                }
              >
                <div class="mt-2 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                  <div class="text-sm text-amber-900 dark:text-amber-100 whitespace-pre-wrap font-mono">
                    {block.thinking}
                  </div>
                </div>
              </Collapsible>
            );
          }

          return null;
        })}

        {/* Parent tool use indicator (for sub-agent messages) */}
        {message.parent_tool_use_id && (
          <div class="text-xs text-gray-500 dark:text-gray-400 italic">
            Sub-agent response (parent: {message.parent_tool_use_id.slice(0, 8)}...)
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Tool Use Block Component
 * Shows tool calls with expandable input/output details
 */
function ToolUseBlock({ block }: { block: Extract<ReturnType<typeof isToolUseBlock> extends true ? any : never, { type: "tool_use" }> }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div class="border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-blue-50 dark:bg-blue-900/10">
      {/* Header - clickable to expand/collapse */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        class="w-full flex items-center justify-between p-3 hover:bg-blue-100 dark:hover:bg-blue-900/20 transition-colors"
      >
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span class="font-mono text-sm font-medium text-blue-900 dark:text-blue-100">
            {block.name}
          </span>
          <span class="text-xs text-blue-600 dark:text-blue-400 font-mono">
            {block.id.slice(0, 8)}...
          </span>
        </div>
        <svg
          class={`w-5 h-5 text-blue-600 dark:text-blue-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded content - input details */}
      {isExpanded && (
        <div class="p-3 border-t border-blue-200 dark:border-blue-800 bg-white dark:bg-gray-900">
          <div class="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Input:</div>
          <pre class="text-xs bg-gray-50 dark:bg-gray-800 p-3 rounded overflow-x-auto border border-gray-200 dark:border-gray-700">
            {JSON.stringify(block.input, null, 2)}
          </pre>

          <div class="mt-2 text-xs text-gray-500 dark:text-gray-400 italic">
            Tool output will appear in result message
          </div>
        </div>
      )}
    </div>
  );
}
