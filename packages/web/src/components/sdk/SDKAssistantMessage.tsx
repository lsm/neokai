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
import MarkdownRenderer from "../chat/MarkdownRenderer.tsx";
import { Collapsible } from "../ui/Collapsible.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { copyToClipboard } from "../../lib/utils.ts";
import { toast } from "../../lib/toast.ts";
import { useState } from "preact/hooks";
import { messageSpacing, messageColors, borderRadius } from "../../lib/design-tokens.ts";
import { cn } from "../../lib/utils.ts";
import { ToolResultCard } from "./tools/index.ts";

type AssistantMessage = Extract<SDKMessage, { type: "assistant" }>;

interface Props {
  message: AssistantMessage;
  toolResultsMap?: Map<string, any>;
}

export function SDKAssistantMessage({ message, toolResultsMap }: Props) {
  const { message: apiMessage } = message;

  // Extract text content for copy functionality
  const getTextContent = (): string => {
    return apiMessage.content
      .map((block) => {
        if (isTextBlock(block)) {
          return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  };

  const handleCopy = async () => {
    const textContent = getTextContent();
    const success = await copyToClipboard(textContent);
    if (success) {
      toast.success("Message copied to clipboard");
    } else {
      toast.error("Failed to copy message");
    }
  };

  const getTimestamp = (): string => {
    return new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Separate blocks by type - tool use and thinking blocks get full width, text blocks are constrained
  const textBlocks = apiMessage.content.filter(block => isTextBlock(block));
  const toolBlocks = apiMessage.content.filter(isToolUseBlock);
  const thinkingBlocks = apiMessage.content.filter(isThinkingBlock);

  return (
    <div class="py-2 space-y-3">
      {/* Tool use blocks - full width like result messages */}
      {toolBlocks.map((block, idx) => {
        const toolResult = toolResultsMap?.get(block.id);
        return <ToolUseBlock key={`tool-${idx}`} block={block} toolResult={toolResult} />;
      })}

      {/* Thinking blocks - treated as tool blocks for unified UI */}
      {thinkingBlocks.map((block, idx) => (
        <ToolResultCard
          key={`thinking-${idx}`}
          toolName="Thinking"
          toolId={`thinking-${idx}`}
          input={block.thinking}
          output={null}
          isError={false}
          variant="default"
        />
      ))}

      {/* Text blocks - constrained width */}
      {textBlocks.length > 0 && (
        <div class="max-w-[85%] md:max-w-[70%] w-auto">
          <div class={cn(messageColors.assistant.background, borderRadius.message.bubble, messageSpacing.assistant.bubble.combined, "space-y-3")}>
            {textBlocks.map((block, idx) => (
              <div key={idx} class={messageColors.assistant.text}>
                <MarkdownRenderer
                  content={block.text}
                  class="dark:prose-invert max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100"
                />
              </div>
            ))}

            {/* Parent tool use indicator (for sub-agent messages) */}
            {message.parent_tool_use_id && (
              <div class="text-xs text-gray-500 dark:text-gray-400 italic">
                Sub-agent response (parent: {message.parent_tool_use_id.slice(0, 8)}...)
              </div>
            )}
          </div>

          {/* Actions and timestamp - bottom left */}
          <div class={cn("flex items-center", messageSpacing.actions.gap, messageSpacing.actions.marginTop, messageSpacing.actions.padding)}>
            <Tooltip content={new Date().toLocaleString()} position="right">
              <span class="text-xs text-gray-500">{getTimestamp()}</span>
            </Tooltip>

            <IconButton size="md" onClick={handleCopy} title="Copy message">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </IconButton>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Get icon SVG for a specific tool type
 */
function getToolIcon(toolName: string) {
  switch (toolName) {
    // File operations
    case 'Write':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      );
    case 'Edit':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
      );
    case 'Read':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      );
    case 'NotebookEdit':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
      );

    // Search operations
    case 'Glob':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      );
    case 'Grep':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      );

    // Terminal
    case 'Bash':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      );

    // Agent/Task
    case 'Task':
    case 'Agent':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
      );

    // Web operations
    case 'WebFetch':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
        </svg>
      );
    case 'WebSearch':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
      );

    // Todo
    case 'TodoWrite':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      );

    // Default fallback - wrench icon
    default:
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
  }
}

/**
 * Tool Use Block Component
 * Now uses the new ToolResultCard component
 */
function ToolUseBlock({ block, toolResult }: { block: Extract<ReturnType<typeof isToolUseBlock> extends true ? any : never, { type: "tool_use" }>, toolResult?: any }) {
  return (
    <ToolResultCard
      toolName={block.name}
      toolId={block.id}
      input={block.input}
      output={toolResult}
      isError={toolResult?.is_error || false}
      variant="default"
    />
  );
}

// ============================================================================
// LEGACY CODE BELOW - KEPT FOR REFERENCE, CAN BE REMOVED AFTER TESTING
// ============================================================================

/**
 * @deprecated Legacy icon function - now handled by ToolIcon component
 */
function getToolIcon_LEGACY(toolName: string) {
  // This function has been moved to ToolIcon component
  // Can be removed after testing
  return null;
}

/**
 * @deprecated Legacy summary function - now handled by ToolSummary component
 */
function getToolSummary_LEGACY() {
  // This function has been moved to tool-registry.ts as summaryExtractor functions
  // Can be removed after testing
}
