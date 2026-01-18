/**
 * ChatHeader Component
 *
 * Header section for the chat container with session title, stats, and action menu.
 * Extracted from ChatContainer.tsx for better separation of concerns.
 */

import type { Session } from "@liuboer/shared";
import { borderColors } from "../lib/design-tokens";
import { formatTokens } from "../lib/utils";
import { sidebarOpenSignal } from "../lib/signals";
import { connectionState } from "../lib/state";
import { IconButton } from "./ui/IconButton";
import { Dropdown } from "./ui/Dropdown";
import { Tooltip } from "./ui/Tooltip";
import { GitBranchIcon } from "./icons/GitBranchIcon";

export interface ChatHeaderProps {
  session: Session | null;
  displayStats: {
    totalTokens: number;
    totalCost: number;
  };
  onToolsClick: () => void;
  onExportClick: () => void;
  onResetClick: () => void;
  onArchiveClick: () => void;
  onDeleteClick: () => void;
  archiving?: boolean;
  resettingAgent?: boolean;
}

export function ChatHeader({
  session,
  displayStats,
  onToolsClick,
  onExportClick,
  onResetClick,
  onArchiveClick,
  onDeleteClick,
  archiving = false,
  resettingAgent = false,
}: ChatHeaderProps) {
  const isConnected = connectionState.value === "connected";

  const handleMenuClick = () => {
    sidebarOpenSignal.value = true;
  };

  const getHeaderActions = () => [
    {
      label: "Tools",
      onClick: onToolsClick,
      icon: (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
          />
        </svg>
      ),
    },
    {
      label: "Export Chat",
      onClick: onExportClick,
      disabled: !isConnected,
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
    {
      label: resettingAgent ? "Resetting..." : "Reset Agent",
      onClick: onResetClick,
      disabled: resettingAgent || !isConnected,
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
    },
    { type: "divider" as const },
    {
      label: "Archive Session",
      onClick: onArchiveClick,
      disabled: archiving || session?.status === "archived" || !isConnected,
      icon: (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
          />
        </svg>
      ),
    },
    {
      label: "Delete Chat",
      onClick: onDeleteClick,
      danger: true,
      disabled: !isConnected,
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

  return (
    <div
      class={`flex-shrink-0 bg-dark-850/50 backdrop-blur-sm border-b ${borderColors.ui.default} p-4 relative z-10`}
    >
      <div class="max-w-4xl mx-auto w-full px-4 md:px-0 flex items-center gap-3">
        {/* Hamburger menu button - visible only on mobile */}
        <button
          onClick={handleMenuClick}
          class={`md:hidden p-2 -ml-2 bg-dark-850 border ${borderColors.ui.default} rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0`}
          title="Open menu"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>

        {/* Session title and stats */}
        <div class="flex-1 min-w-0">
          <h2 class="text-lg font-semibold text-gray-100 truncate">
            {session?.title || "New Session"}
          </h2>
          <div class="flex items-center gap-3 mt-1 text-xs text-gray-400">
            <span class="flex items-center gap-1" title="Total tokens">
              <svg class="w-3 h-3" fill="currentColor" viewBox="-1 -1 18 18">
                <path d="M8 2a.5.5 0 0 1 .5.5V4a.5.5 0 0 1-1 0V2.5A.5.5 0 0 1 8 2M3.732 3.732a.5.5 0 0 1 .707 0l.915.914a.5.5 0 1 1-.708.708l-.914-.915a.5.5 0 0 1 0-.707M2 8a.5.5 0 0 1 .5-.5h1.586a.5.5 0 0 1 0 1H2.5A.5.5 0 0 1 2 8m9.5 0a.5.5 0 0 1 .5-.5h1.5a.5.5 0 0 1 0 1H12a.5.5 0 0 1-.5-.5m.754-4.246a.39.39 0 0 0-.527-.02L7.547 7.31A.91.91 0 1 0 8.85 8.569l3.434-4.297a.39.39 0 0 0-.029-.518z" />
                <path
                  fill-rule="evenodd"
                  d="M6.664 15.889A8 8 0 1 1 9.336.11a8 8 0 0 1-2.672 15.78zm-4.665-4.283A11.95 11.95 0 0 1 8 10c2.186 0 4.236.585 6.001 1.606a7 7 0 1 0-12.002 0"
                />
              </svg>
              {formatTokens(displayStats.totalTokens)}
            </span>
            <span class="text-gray-500">•</span>
            <span class="font-mono text-green-400">
              ${displayStats.totalCost.toFixed(4)}
            </span>
          </div>
          {/* Git branch info */}
          {(session?.worktree?.branch || session?.gitBranch) && (
            <div class="flex items-center gap-1.5 mt-1 text-xs text-gray-500">
              <svg
                class="w-3 h-3"
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
              <span class="font-mono">
                {session?.worktree?.branch || session?.gitBranch}
              </span>
              {session?.worktree && (
                <Tooltip
                  content="Using isolated git worktree"
                  position="bottom"
                >
                  <GitBranchIcon className="w-3.5 h-3.5 text-purple-400" />
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {/* Options dropdown */}
        <Dropdown
          trigger={
            <IconButton
              title={!isConnected ? "Not connected" : "Session options"}
              disabled={!isConnected}
            >
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
              </svg>
            </IconButton>
          }
          items={getHeaderActions()}
        />
      </div>
    </div>
  );
}
