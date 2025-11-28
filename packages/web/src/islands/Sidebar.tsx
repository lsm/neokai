import { useState } from "preact/hooks";
import { currentSessionIdSignal, sidebarOpenSignal } from "../lib/signals.ts";
import { sessions, authStatus } from "../lib/state.ts";
import { createSession } from "../lib/api-helpers.ts";
import { formatRelativeTime } from "../lib/utils.ts";
import { toast } from "../lib/toast.ts";
import { Button } from "../components/ui/Button.tsx";
import { SettingsModal } from "../components/SettingsModal.tsx";

export default function Sidebar() {
  // Keep local UI state
  const [creatingSession, setCreatingSession] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // IMPORTANT: Do NOT access .value here - only access in JSX for proper reactivity tracking
  // Debug logging will happen when signals are accessed in JSX below

  const handleCreateSession = async () => {
    setCreatingSession(true);

    try {
      const response = await createSession({
        workspacePath: undefined, // Let daemon use configured workspace root
      });

      if (!response?.sessionId) {
        console.error("[Sidebar] Invalid response from createSession:", response);
        toast.error("No sessionId in response");
        return;
      }

      console.log("[Sidebar] Session created successfully, sessionId:", response.sessionId);
      console.log("[Sidebar] Response includes session:", !!response.session);

      // Navigate immediately - the session will sync via state channels
      console.log("[Sidebar] Navigating to session:", response.sessionId);
      currentSessionIdSignal.value = response.sessionId;

      // FIX: Force a manual refresh of sessions list after a short delay
      // to ensure the session appears even if delta doesn't arrive
      setTimeout(async () => {
        const currentSessionIds = sessions.value.map(s => s.id);
        if (!currentSessionIds.includes(response.sessionId)) {
          console.warn("[Sidebar] Session not in list after navigation, forcing refresh");
          // Trigger a refresh by accessing the state channel
          const global = (await import("../lib/state.ts")).appState.global.value;
          if (global) {
            await global.sessions.refresh();
            console.log("[Sidebar] Sessions list refreshed");
          }
        } else {
          console.log("[Sidebar] Session successfully appeared in list");
        }
      }, 1000); // Wait 1 second for delta to arrive

      toast.success("Session created successfully");
    } catch (err) {
      console.error("[Sidebar] Error creating session:", err);
      const message = err instanceof Error
        ? err.message
        : "Failed to create session";
      toast.error(message);
    } finally {
      setCreatingSession(false);
    }
  };

  const handleSessionClick = (sessionId: string) => {
    currentSessionIdSignal.value = sessionId;
    // Close sidebar on mobile after selecting a session
    if (window.innerWidth < 768) {
      sidebarOpenSignal.value = false;
    }
  };

  return (
    <>
      {/* Mobile backdrop */}
      {sidebarOpenSignal.value && (
        <div
          class="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => sidebarOpenSignal.value = false}
        />
      )}
      <div class={`
        fixed md:relative
        h-screen w-80
        bg-dark-950 border-r border-dark-700
        flex flex-col
        z-50
        transition-transform duration-300 ease-in-out
        ${sidebarOpenSignal.value ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        {/* Header */}
        <div class="p-4 border-b border-dark-700">
          <div class="flex items-center gap-3 mb-4">
            <div class="text-2xl">🤖</div>
            <h1 class="text-xl font-bold text-gray-100 flex-1">Liuboer</h1>
            {/* Close button for mobile */}
            <button
              onClick={() => sidebarOpenSignal.value = false}
              class="md:hidden p-1.5 hover:bg-dark-800 rounded-lg transition-colors text-gray-400 hover:text-gray-100"
              title="Close sidebar"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <Button
            onClick={handleCreateSession}
            loading={creatingSession}
            fullWidth
            icon={
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            }
          >
            New Session
          </Button>
        </div>

        {/* Session List */}
        <div class="flex-1 overflow-y-auto">
          {sessions.value.length === 0 && (
            <div class="p-6 text-center">
              <div class="text-4xl mb-3">💬</div>
              <p class="text-sm text-gray-400">
                No sessions yet.
              </p>
              <p class="text-xs text-gray-500 mt-1">
                Create one to get started!
              </p>
            </div>
          )}

          {sessions.value.map((session) => {
            const isActive = currentSessionIdSignal.value === session.id;

            return (
              <div
                key={session.id}
                data-testid="session-card"
                data-session-id={session.id}
                onClick={() => handleSessionClick(session.id)}
                class={`group relative p-4 border-b border-dark-700 cursor-pointer transition-all ${
                  isActive
                    ? "bg-dark-850 border-l-2 border-l-blue-500"
                    : "hover:bg-dark-900"
                }`}
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="flex-1 min-w-0">
                    <h3
                      class={`font-medium truncate text-sm mb-1 ${
                        isActive ? "text-gray-100" : "text-gray-200"
                      }`}
                    >
                      {session.title || "New Session"}
                    </h3>
                    <div class="flex items-center gap-3 text-xs text-gray-500">
                      <span class="flex items-center gap-1">
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
                            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                          />
                        </svg>
                        {session.metadata.messageCount || 0}
                      </span>
                      <span class="flex items-center gap-1">
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
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div class="p-4 border-t border-dark-700 space-y-3">
          {/* Auth Status */}
          <div class="flex items-center justify-between text-xs">
            <span class="text-gray-400">Authentication</span>
            <button
              onClick={() => setSettingsOpen(true)}
              class="flex items-center gap-2 hover:bg-dark-800 px-2 py-1 rounded transition-colors"
            >
              {authStatus.value?.isAuthenticated ? (
                <>
                  <div class="relative">
                    <span class="w-2 h-2 bg-green-500 rounded-full block" />
                    <span class="absolute inset-0 w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75" />
                  </div>
                  <span class="text-gray-300 flex items-center gap-1">
                    {authStatus.value.method === "oauth"
                      ? "OAuth"
                      : authStatus.value.method === "oauth_token"
                      ? "OAuth Token"
                      : "API Key"}
                    {authStatus.value.source === "env" && (
                      <span class="text-[10px] px-1 bg-blue-500/20 text-blue-300 rounded">
                        env
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <div class="w-2 h-2 bg-yellow-500 rounded-full" />
                  <span class="text-yellow-300">Not configured</span>
                </>
              )}
              <svg
                class="w-3 h-3 text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
          </div>

          {/* Connection Status */}
          <div class="flex items-center justify-between text-xs">
            <span class="text-gray-400">Status</span>
            <div class="flex items-center gap-2">
              <div class="relative">
                <span class="w-2 h-2 bg-green-500 rounded-full block" />
                <span class="absolute inset-0 w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75" />
              </div>
              <span class="text-gray-300">Connected</span>
            </div>
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
}
