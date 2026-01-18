/**
 * SessionIndicator Component
 *
 * Dropdown content showing session start information in indigo theme
 * Triggered by info icon button in user message actions
 */

import type { SDKMessage } from "@liuboer/shared/sdk/sdk.d.ts";

type SystemInitMessage = Extract<
  SDKMessage,
  { type: "system"; subtype: "init" }
>;

interface Props {
  sessionInfo: SystemInitMessage;
}

export function SessionIndicator({ sessionInfo }: Props) {
  const simplifiedModel = sessionInfo.model
    .replace("claude-", "")
    .replace("anthropic.", "");

  return (
    <div class="w-80 max-h-[70vh] overflow-y-auto bg-indigo-50 dark:bg-indigo-900/70 rounded-lg border border-indigo-200 dark:border-indigo-800 p-3 space-y-3 shadow-2xl backdrop-blur-sm">
      {/* Header */}
      <div class="flex items-center gap-2 pb-2 border-b border-indigo-200 dark:border-indigo-800">
        <svg
          class="w-4 h-4 text-indigo-600 dark:text-indigo-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
        <div class="text-sm">
          <span class="font-medium text-indigo-900 dark:text-indigo-100">
            Session Started
          </span>
          <span class="text-indigo-600 dark:text-indigo-400 ml-2">
            {simplifiedModel} • {sessionInfo.permissionMode}
          </span>
        </div>
      </div>

      {/* Working Directory */}
      {sessionInfo.cwd && (
        <div>
          <div class="text-xs font-medium text-indigo-900 dark:text-indigo-100 mb-1">
            Working Directory
          </div>
          <div class="font-mono text-xs text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-900/30 rounded px-2 py-1 break-all">
            {sessionInfo.cwd}
          </div>
        </div>
      )}

      {/* Tools */}
      {sessionInfo.tools && sessionInfo.tools.length > 0 && (
        <div>
          <div class="text-xs font-medium text-indigo-900 dark:text-indigo-100 mb-1">
            Tools ({sessionInfo.tools.length})
          </div>
          <div class="flex flex-wrap gap-1">
            {sessionInfo.tools.map((tool) => (
              <span
                key={tool}
                class="px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded text-xs"
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* MCP Servers */}
      {sessionInfo.mcp_servers && sessionInfo.mcp_servers.length > 0 && (
        <div>
          <div class="text-xs font-medium text-indigo-900 dark:text-indigo-100 mb-1">
            MCP Servers ({sessionInfo.mcp_servers.length})
          </div>
          <div class="space-y-1">
            {sessionInfo.mcp_servers.map((server) => (
              <div key={server.name} class="flex items-center gap-2">
                <div
                  class={`w-1.5 h-1.5 rounded-full ${
                    server.status === "connected"
                      ? "bg-green-500"
                      : "bg-gray-500"
                  }`}
                  title={server.status}
                />
                <span class="text-xs text-indigo-700 dark:text-indigo-300">
                  {server.name}
                </span>
                <span class="text-xs text-indigo-500 dark:text-indigo-400">
                  ({server.status})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Slash Commands */}
      {sessionInfo.slash_commands && sessionInfo.slash_commands.length > 0 && (
        <div>
          <div class="text-xs font-medium text-indigo-900 dark:text-indigo-100 mb-1">
            Slash Commands ({sessionInfo.slash_commands.length})
          </div>
          <div class="flex flex-wrap gap-1">
            {sessionInfo.slash_commands.map((cmd) => (
              <span
                key={cmd}
                class="px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded text-xs font-mono"
              >
                /{cmd}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Agents */}
      {sessionInfo.agents && sessionInfo.agents.length > 0 && (
        <div>
          <div class="text-xs font-medium text-indigo-900 dark:text-indigo-100 mb-1">
            Agents ({sessionInfo.agents.length})
          </div>
          <div class="flex flex-wrap gap-1">
            {sessionInfo.agents.map((agent) => (
              <span
                key={agent}
                class="px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded text-xs"
              >
                {agent}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Other details */}
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-indigo-600 dark:text-indigo-400 pt-2 border-t border-indigo-200 dark:border-indigo-800">
        <div>
          <span class="font-medium">API Key:</span> {sessionInfo.apiKeySource}
        </div>
        <div>
          <span class="font-medium">Output:</span> {sessionInfo.output_style}
        </div>
      </div>
    </div>
  );
}
