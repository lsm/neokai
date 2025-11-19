import type { Session } from "@liuboer/shared";
import { currentSessionIdSignal, sidebarOpenSignal } from "../lib/signals.ts";
import { formatRelativeTime } from "../lib/utils.ts";

interface RecentSessionsProps {
  sessions: Session[];
}

export default function RecentSessions({ sessions }: RecentSessionsProps) {
  // Get the 5 most recent sessions
  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(0, 5);

  const handleSessionClick = (sessionId: string) => {
    currentSessionIdSignal.value = sessionId;
    // Close sidebar on mobile after selecting a session
    if (window.innerWidth < 768) {
      sidebarOpenSignal.value = false;
    }
  };

  const handleMenuClick = () => {
    sidebarOpenSignal.value = true;
  };

  return (
    <div class="flex-1 flex flex-col bg-dark-900 overflow-hidden">
      {/* Header with hamburger menu */}
      <div class="bg-dark-850/50 backdrop-blur-sm border-b border-dark-700 p-4">
        <div class="max-w-6xl mx-auto w-full px-4 md:px-6 flex items-center gap-3">
          {/* Hamburger menu button - visible only on mobile */}
          <button
            onClick={handleMenuClick}
            class="md:hidden p-2 -ml-2 bg-dark-850 border border-dark-700 rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0"
            title="Open menu"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div class="flex-1">
            <h2 class="text-2xl font-bold text-gray-100">Welcome to Liuboer</h2>
            <p class="text-sm text-gray-400 mt-1">
              {recentSessions.length > 0 ? "Continue where you left off or create a new session" : "Create a new session to get started"}
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto">
        <div class="max-w-6xl mx-auto w-full px-4 md:px-6 py-8">
          {/* Welcome message */}
          <div class="text-center mb-8">
            <div class="text-5xl mb-4">🤖</div>
            <p class="text-gray-400 text-base mb-6">
              A modern wrapper around Claude Agent SDK with rich UI and multi-device access
            </p>
            <div class="flex flex-wrap justify-center gap-4 text-sm text-gray-400">
              <span class="flex items-center gap-2">
                <span>✨</span>
                <span>Real-time streaming</span>
              </span>
              <span class="flex items-center gap-2">
                <span>🛠️</span>
                <span>Tool visualization</span>
              </span>
              <span class="flex items-center gap-2">
                <span>📁</span>
                <span>Workspace management</span>
              </span>
              <span class="flex items-center gap-2">
                <span>💬</span>
                <span>Multi-session support</span>
              </span>
            </div>
          </div>

          {/* Recent Sessions */}
          {recentSessions.length > 0 && (
            <div>
              <h3 class="text-lg font-semibold text-gray-100 mb-4">Recent Sessions</h3>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {recentSessions.map((session) => (
              <button
                key={session.id}
                onClick={() => handleSessionClick(session.id)}
                class="group relative bg-dark-850 border border-dark-700 rounded-lg p-5 hover:bg-dark-800 hover:border-dark-600 transition-all text-left cursor-pointer hover:shadow-lg hover:shadow-blue-500/10"
              >
                {/* Session header */}
                <div class="mb-3">
                  <h3 class="text-lg font-semibold text-gray-100 mb-1 line-clamp-2 group-hover:text-blue-400 transition-colors">
                    {session.title || "New Session"}
                  </h3>
                  <p class="text-xs text-gray-500 flex items-center gap-1">
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
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    {formatRelativeTime(new Date(session.lastActiveAt))}
                  </p>
                </div>

                {/* Session stats */}
                <div class="grid grid-cols-2 gap-3">
                  <div class="bg-dark-900/50 rounded-lg p-3">
                    <div class="flex items-center gap-2 mb-1">
                      <svg
                        class="w-4 h-4 text-blue-400"
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
                      <span class="text-xs text-gray-400">Messages</span>
                    </div>
                    <div class="text-xl font-bold text-gray-100">
                      {session.metadata.messageCount || 0}
                    </div>
                  </div>

                  <div class="bg-dark-900/50 rounded-lg p-3">
                    <div class="flex items-center gap-2 mb-1">
                      <svg
                        class="w-4 h-4 text-purple-400"
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
                      <span class="text-xs text-gray-400">Tokens</span>
                    </div>
                    <div class="text-xl font-bold text-gray-100">
                      {session.metadata.totalTokens?.toLocaleString() || 0}
                    </div>
                  </div>
                </div>

                {/* Hover indicator */}
                <div class="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <svg
                    class="w-5 h-5 text-blue-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M13 7l5 5m0 0l-5 5m5-5H6"
                    />
                  </svg>
                </div>
              </button>
            ))}
              </div>

              {/* Show more sessions hint */}
              {sessions.length > 5 && (
                <div class="mt-6 text-center">
                  <p class="text-sm text-gray-400">
                    Showing {recentSessions.length} of {sessions.length} sessions
                  </p>
                  <p class="text-xs text-gray-500 mt-1">
                    View all sessions in the sidebar
                  </p>
                </div>
              )}
            </div>
          )}

          {/* No sessions state */}
          {recentSessions.length === 0 && (
            <div class="text-center mt-8">
              <p class="text-gray-500 text-sm">
                No sessions yet. Create a new session from the sidebar to start chatting.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
