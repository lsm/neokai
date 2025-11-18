import { useEffect, useState } from "preact/hooks";
import type { AuthStatus, Session } from "@liuboer/shared";
import { apiClient } from "../lib/api-client.ts";
import { currentSessionIdSignal, sidebarOpenSignal } from "../lib/signals.ts";
import { formatRelativeTime } from "../lib/utils.ts";
import { toast } from "../lib/toast.ts";
import { Button } from "../components/ui/Button.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { Dropdown } from "../components/ui/Dropdown.tsx";
import { Modal } from "../components/ui/Modal.tsx";
import { SkeletonSession } from "../components/ui/Skeleton.tsx";
import { SettingsModal } from "../components/SettingsModal.tsx";

export default function Sidebar() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    loadSessions();
    loadAuthStatus();
  }, []);

  // Auto-select most recent session if none is selected
  useEffect(() => {
    console.log("Auto-select effect triggered:", {
      sessionsCount: sessions.length,
      currentSessionId: currentSessionIdSignal.value,
    });

    if (sessions.length > 0 && !currentSessionIdSignal.value) {
      // Sort by lastActiveAt and select the most recent
      const mostRecent = [...sessions].sort((a, b) =>
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
      )[0];

      console.log("Auto-selecting session:", mostRecent.id, mostRecent.title);

      if (mostRecent) {
        currentSessionIdSignal.value = mostRecent.id;
      }
    }
  }, [sessions]);

  const loadSessions = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.listSessions();
      setSessions(response.sessions);
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to load sessions";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const loadAuthStatus = async () => {
    try {
      const response = await apiClient.getAuthStatus();
      setAuthStatus(response.authStatus);
    } catch (err) {
      console.error("Failed to load auth status:", err);
    }
  };

  const handleCreateSession = async () => {
    try {
      setCreatingSession(true);
      const response = await apiClient.createSession({
        workspacePath: "/tmp/workspace",
      });
      await loadSessions();
      currentSessionIdSignal.value = response.sessionId;
      toast.success("Session created successfully");
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to create session";
      setError(message);
      toast.error(message);
    } finally {
      setCreatingSession(false);
    }
  };

  const confirmDeleteSession = (sessionId: string, e: Event) => {
    e.stopPropagation();
    setSessionToDelete(sessionId);
    setDeleteModalOpen(true);
  };

  const handleDeleteSession = async () => {
    if (!sessionToDelete) return;

    try {
      // Check if we need to select a new session before deleting
      const wasActiveSession = currentSessionIdSignal.value === sessionToDelete;

      await apiClient.deleteSession(sessionToDelete);

      // Reload sessions to get the updated list from API
      const response = await apiClient.listSessions();
      setSessions(response.sessions);

      // If the deleted session was active, select another one
      if (wasActiveSession) {
        if (response.sessions.length > 0) {
          // Select the most recent session
          const mostRecent = [...response.sessions].sort((a, b) =>
            new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
          )[0];
          currentSessionIdSignal.value = mostRecent.id;
        } else {
          currentSessionIdSignal.value = null;
        }
      }

      toast.success("Session deleted");
      setDeleteModalOpen(false);
      setSessionToDelete(null);
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to delete session";
      toast.error(message);
    }
  };

  const getSessionMenuItems = (sessionId: string) => [
    {
      label: "Rename",
      onClick: () => toast.info("Rename feature coming soon"),
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
    },
    {
      label: "Duplicate",
      onClick: () => toast.info("Duplicate feature coming soon"),
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
    {
      label: "Export",
      onClick: () => toast.info("Export feature coming soon"),
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
    { type: "divider" as const },
    {
      label: "Delete",
      onClick: (e: Event) => confirmDeleteSession(sessionId, e),
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
    },
  ];

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
          {loading && (
            <div class="divide-y divide-dark-700">
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonSession key={i} />
              ))}
            </div>
          )}

          {error && !loading && (
            <div class="p-4 m-4 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p class="text-sm text-red-400">{error}</p>
              <Button
                onClick={loadSessions}
                variant="ghost"
                size="sm"
                class="mt-2"
              >
                Retry
              </Button>
            </div>
          )}

          {!loading && sessions.length === 0 && (
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

          {!loading && sessions.map((session) => {
            const isActive = currentSessionIdSignal.value === session.id;

            return (
              <div
                key={session.id}
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

                  {/* Actions Menu */}
                  <div
                    class={`transition-opacity ${
                      isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dropdown
                      trigger={
                        <IconButton
                          size="sm"
                          title="Session options"
                        >
                          <svg
                            class="w-4 h-4"
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                          </svg>
                        </IconButton>
                      }
                      items={getSessionMenuItems(session.id)}
                    />
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
              {authStatus?.isAuthenticated ? (
                <>
                  <div class="relative">
                    <span class="w-2 h-2 bg-green-500 rounded-full block" />
                    <span class="absolute inset-0 w-2 h-2 bg-green-500 rounded-full animate-ping opacity-75" />
                  </div>
                  <span class="text-gray-300 flex items-center gap-1">
                    {authStatus.method === "oauth"
                      ? "OAuth"
                      : authStatus.method === "oauth_token"
                      ? "OAuth Token"
                      : "API Key"}
                    {authStatus.source === "env" && (
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
        onClose={() => {
          setSettingsOpen(false);
          loadAuthStatus(); // Reload auth status when modal closes
        }}
      />

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={deleteModalOpen}
        onClose={() => {
          setDeleteModalOpen(false);
          setSessionToDelete(null);
        }}
        title="Delete Session"
        size="sm"
      >
        <div class="space-y-4">
          <p class="text-gray-300 text-sm">
            Are you sure you want to delete this session? This action cannot be undone.
          </p>
          <div class="flex gap-3 justify-end">
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteModalOpen(false);
                setSessionToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDeleteSession}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
