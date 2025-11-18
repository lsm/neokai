import { useEffect, useState } from "preact/hooks";
import type { Session } from "@liuboer/shared";
import { apiClient } from "../lib/api-client.ts";
import { currentSessionIdSignal } from "../lib/signals.ts";

export default function Sidebar() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.listSessions();
      setSessions(response.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSession = async () => {
    try {
      setCreatingSession(true);
      const response = await apiClient.createSession({
        workspacePath: "/tmp/workspace", // Default workspace path
      });
      await loadSessions();
      currentSessionIdSignal.value = response.sessionId;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setCreatingSession(false);
    }
  };

  const handleDeleteSession = async (sessionId: string, e: Event) => {
    e.stopPropagation();
    if (!confirm("Delete this session?")) return;

    try {
      await apiClient.deleteSession(sessionId);
      await loadSessions();
      if (currentSessionIdSignal.value === sessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) {
          currentSessionIdSignal.value = remaining[0].id;
        } else {
          currentSessionIdSignal.value = null;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete session");
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / 1000 / 60 / 60);

    if (hours < 1) return "Just now";
    if (hours < 24) return `${hours}h ago`;
    if (hours < 48) return "Yesterday";
    return date.toLocaleDateString();
  };

  return (
    <div class="h-screen w-80 bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <div class="p-4 border-b border-gray-700">
        <h1 class="text-xl font-bold mb-4">Liuboer</h1>
        <button
          type="button"
          onClick={handleCreateSession}
          disabled={creatingSession}
          class="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 rounded-lg text-sm font-medium transition-colors"
        >
          {creatingSession ? "Creating..." : "+ New Session"}
        </button>
      </div>

      {/* Session List */}
      <div class="flex-1 overflow-y-auto">
        {loading && <div class="p-4 text-center text-gray-400">Loading sessions...</div>}

        {error && <div class="p-4 text-center text-red-400 text-sm">{error}</div>}

        {!loading && sessions.length === 0 && (
          <div class="p-4 text-center text-gray-400 text-sm">
            No sessions yet. Create one to get started!
          </div>
        )}

        {!loading && sessions.map((session) => (
          <div
            key={session.id}
            onClick={() => currentSessionIdSignal.value = session.id}
            class={`p-4 border-b border-gray-800 cursor-pointer hover:bg-gray-800 transition-colors ${
              currentSessionIdSignal.value === session.id ? "bg-gray-800" : ""
            }`}
          >
            <div class="flex items-start justify-between">
              <div class="flex-1 min-w-0">
                <h3 class="font-medium truncate text-sm">
                  {session.title || "New Session"}
                </h3>
                <p class="text-xs text-gray-400 mt-1">
                  {session.metadata.messageCount} messages
                </p>
                <p class="text-xs text-gray-500 mt-1">
                  {formatDate(session.lastActiveAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => handleDeleteSession(session.id, e)}
                class="ml-2 p-1 text-gray-400 hover:text-red-400 transition-colors"
                title="Delete session"
              >
                <svg
                  class="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div class="p-4 border-t border-gray-700 text-xs text-gray-400">
        <div class="flex items-center justify-between">
          <span>Status:</span>
          <span class="flex items-center">
            <span class="w-2 h-2 bg-green-500 rounded-full mr-2"></span>
            Connected
          </span>
        </div>
      </div>
    </div>
  );
}
