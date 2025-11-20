/**
 * SDKToolProgressMessage Renderer
 *
 * Displays real-time tool execution progress with elapsed time
 */

import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";

type ToolProgressMessage = Extract<SDKMessage, { type: "tool_progress" }>;

interface Props {
  message: ToolProgressMessage;
  toolInput?: any; // Tool input parameters (e.g., file_path for Write/Edit tools)
}

/**
 * Get icon SVG for a specific tool type
 */
function getToolIcon(toolName: string) {
  switch (toolName) {
    // File operations
    case 'Write':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
    case 'Edit':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
    case 'Read':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
    case 'NotebookEdit':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );

    // Search operations
    case 'Glob':
    case 'Grep':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );

    // Terminal
    case 'Bash':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );

    // Agent/Task
    case 'Task':
    case 'Agent':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );

    // Web operations
    case 'WebFetch':
    case 'WebSearch':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );

    // Todo
    case 'TodoWrite':
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );

    // Default fallback - spinner
    default:
      return (
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      );
  }
}

export function SDKToolProgressMessage({ message, toolInput }: Props) {
  // Get a readable summary based on tool type and input
  const getToolSummary = (): string | null => {
    if (!toolInput) return null;

    // For Write tool, show the file path
    if (message.tool_name === 'Write' && toolInput.file_path) {
      const parts = toolInput.file_path.split('/');
      return parts[parts.length - 1] || toolInput.file_path;
    }

    // For Edit tool, show the file path
    if (message.tool_name === 'Edit' && toolInput.file_path) {
      const parts = toolInput.file_path.split('/');
      return parts[parts.length - 1] || toolInput.file_path;
    }

    // For Read tool, show the file path
    if (message.tool_name === 'Read' && toolInput.file_path) {
      const parts = toolInput.file_path.split('/');
      return parts[parts.length - 1] || toolInput.file_path;
    }

    // For Glob tool, show the pattern
    if (message.tool_name === 'Glob' && toolInput.pattern) {
      return toolInput.pattern.length > 50
        ? toolInput.pattern.slice(0, 50) + '...'
        : toolInput.pattern;
    }

    // For Grep tool, show the pattern
    if (message.tool_name === 'Grep' && toolInput.pattern) {
      return toolInput.pattern.length > 50
        ? toolInput.pattern.slice(0, 50) + '...'
        : toolInput.pattern;
    }

    // For Bash tool, show the command
    if (message.tool_name === 'Bash' && toolInput.command) {
      return toolInput.command.length > 50
        ? toolInput.command.slice(0, 50) + '...'
        : toolInput.command;
    }

    // For Task/Agent tool, show the description
    if ((message.tool_name === 'Task' || message.tool_name === 'Agent') && toolInput.description) {
      return toolInput.description;
    }

    // For WebFetch tool, show the URL
    if (message.tool_name === 'WebFetch' && toolInput.url) {
      return toolInput.url.length > 50
        ? toolInput.url.slice(0, 50) + '...'
        : toolInput.url;
    }

    // For WebSearch tool, show the query
    if (message.tool_name === 'WebSearch' && toolInput.query) {
      return toolInput.query.length > 50
        ? toolInput.query.slice(0, 50) + '...'
        : toolInput.query;
    }

    // For NotebookEdit tool, show the notebook path
    if (message.tool_name === 'NotebookEdit' && toolInput.notebook_path) {
      const parts = toolInput.notebook_path.split('/');
      return parts[parts.length - 1] || toolInput.notebook_path;
    }

    return null;
  };

  const summary = getToolSummary();

  return (
    <div class="py-2 px-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 flex items-center gap-3">
      {/* Tool-specific icon */}
      <div class="flex-shrink-0">
        {getToolIcon(message.tool_name)}
      </div>

      {/* Tool info */}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-mono text-sm font-medium text-blue-900 dark:text-blue-100">
            {message.tool_name}
          </span>
          <span class="text-xs text-blue-600 dark:text-blue-400">
            {message.elapsed_time_seconds.toFixed(1)}s
          </span>
        </div>

        {summary ? (
          <div class="text-xs text-blue-700 dark:text-blue-300 truncate" title={summary}>
            {summary}
          </div>
        ) : (
          <div class="text-xs text-blue-700 dark:text-blue-300 truncate">
            Tool ID: {message.tool_use_id.slice(0, 12)}...
            {message.parent_tool_use_id && (
              <span class="ml-2">
                (parent: {message.parent_tool_use_id.slice(0, 8)}...)
              </span>
            )}
          </div>
        )}
      </div>

      {/* Progress indicator */}
      <div class="flex-shrink-0">
        <div class="flex gap-1">
          <div class="w-1.5 h-1.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-pulse" style="animation-delay: 0ms" />
          <div class="w-1.5 h-1.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-pulse" style="animation-delay: 150ms" />
          <div class="w-1.5 h-1.5 bg-blue-600 dark:bg-blue-400 rounded-full animate-pulse" style="animation-delay: 300ms" />
        </div>
      </div>
    </div>
  );
}
