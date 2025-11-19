/**
 * SDKSystemMessage Renderer
 *
 * Renders system messages:
 * - init: Session initialization with tools, models, permissions
 * - compact_boundary: Compaction metadata
 * - status: Status updates (compacting, etc.)
 * - hook_response: Hook execution results
 */

import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";
import { isSDKSystemInit, isSDKCompactBoundary, isSDKStatusMessage, isSDKHookResponse } from "@liuboer/shared/sdk/type-guards";
import { useState } from "preact/hooks";

type SystemMessage = Extract<SDKMessage, { type: "system" }>;

interface Props {
  message: SystemMessage;
}

export function SDKSystemMessage({ message }: Props) {
  // Init message - session started
  if (isSDKSystemInit(message)) {
    return <SystemInitMessage message={message} />;
  }

  // Compact boundary - shows when message compaction occurred
  if (isSDKCompactBoundary(message)) {
    return (
      <div class="py-2 px-4 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm text-gray-600 dark:text-gray-400 flex items-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span>
          Messages compacted ({message.compact_metadata.trigger === 'manual' ? 'manual' : 'automatic'})
          {' • '}
          {message.compact_metadata.pre_tokens.toLocaleString()} tokens before compaction
        </span>
      </div>
    );
  }

  // Status message
  if (isSDKStatusMessage(message)) {
    if (message.status === 'compacting') {
      return (
        <div class="py-2 px-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-sm text-blue-700 dark:text-blue-300 flex items-center gap-2">
          <div class="animate-spin">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </div>
          <span>Compacting messages...</span>
        </div>
      );
    }
    return null; // Don't show null status
  }

  // Hook response
  if (isSDKHookResponse(message)) {
    return (
      <div class="py-2 px-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
        <div class="text-sm font-medium text-purple-900 dark:text-purple-100 mb-1">
          Hook: {message.hook_name} ({message.hook_event})
        </div>
        {message.stdout && (
          <pre class="text-xs text-purple-700 dark:text-purple-300 whitespace-pre-wrap">
            {message.stdout}
          </pre>
        )}
        {message.stderr && (
          <pre class="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap mt-1">
            {message.stderr}
          </pre>
        )}
        {message.exit_code !== undefined && (
          <div class="text-xs text-purple-600 dark:text-purple-400 mt-1">
            Exit code: {message.exit_code}
          </div>
        )}
      </div>
    );
  }

  return null;
}

/**
 * System Init Message - Shows session startup info
 */
function SystemInitMessage({ message }: { message: Extract<SystemMessage, { subtype: "init" }> }) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div class="py-3 px-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg border border-indigo-200 dark:border-indigo-800">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <div>
            <div class="font-semibold text-indigo-900 dark:text-indigo-100 text-sm">
              Session Started
            </div>
            <div class="text-xs text-indigo-700 dark:text-indigo-300">
              {message.model} • {message.permissionMode} mode • v{message.claude_code_version}
            </div>
          </div>
        </div>
        <button
          onClick={() => setShowDetails(!showDetails)}
          class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200"
        >
          <svg
            class={`w-5 h-5 transition-transform ${showDetails ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {showDetails && (
        <div class="mt-3 pt-3 border-t border-indigo-200 dark:border-indigo-800 space-y-2 text-sm">
          <div>
            <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">Working Directory</div>
            <div class="font-mono text-xs text-indigo-900 dark:text-indigo-100 bg-indigo-100 dark:bg-indigo-900/30 px-2 py-1 rounded">
              {message.cwd}
            </div>
          </div>

          <div>
            <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
              Tools ({message.tools.length})
            </div>
            <div class="flex flex-wrap gap-1">
              {message.tools.map((tool) => (
                <span
                  key={tool}
                  class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded font-mono"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>

          {message.mcp_servers.length > 0 && (
            <div>
              <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
                MCP Servers ({message.mcp_servers.length})
              </div>
              <div class="space-y-1">
                {message.mcp_servers.map((server) => (
                  <div
                    key={server.name}
                    class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-1 rounded flex items-center justify-between"
                  >
                    <span class="font-mono">{server.name}</span>
                    <span class={`text-xs ${server.status === 'connected' ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}>
                      {server.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {message.slash_commands.length > 0 && (
            <div>
              <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
                Slash Commands ({message.slash_commands.length})
              </div>
              <div class="flex flex-wrap gap-1">
                {message.slash_commands.map((cmd) => (
                  <span
                    key={cmd}
                    class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded font-mono"
                  >
                    /{cmd}
                  </span>
                ))}
              </div>
            </div>
          )}

          {message.agents && message.agents.length > 0 && (
            <div>
              <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
                Agents ({message.agents.length})
              </div>
              <div class="flex flex-wrap gap-1">
                {message.agents.map((agent) => (
                  <span
                    key={agent}
                    class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded"
                  >
                    {agent}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div class="text-xs text-indigo-600 dark:text-indigo-400">
            API Key Source: {message.apiKeySource} • Output: {message.output_style}
          </div>
        </div>
      )}
    </div>
  );
}
