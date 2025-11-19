import { currentSessionIdSignal, sidebarOpenSignal } from "../lib/signals.ts";
import ChatContainer from "./ChatContainer.tsx";

export default function MainContent() {
  console.log("MainContent rendering, sessionId:", currentSessionIdSignal.value);

  const handleMenuClick = () => {
    console.log("Menu button clicked! Current sidebar state:", sidebarOpenSignal.value);
    sidebarOpenSignal.value = true;
    console.log("Sidebar state after click:", sidebarOpenSignal.value);
  };

  if (!currentSessionIdSignal.value) {
    return (
      <div class="flex-1 flex items-center justify-center bg-dark-900">
        {!sidebarOpenSignal.value && (
          <button
            onClick={handleMenuClick}
            class="md:hidden fixed top-4 left-4 z-50 p-2 bg-dark-850 border border-dark-700 rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100"
            title="Open menu"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <div class="text-center px-6 max-w-md">
          <div class="mb-6">
            <div class="text-6xl mb-4">🤖</div>
            <h2 class="text-3xl font-bold text-gray-100 mb-3">
              Welcome to Liuboer
            </h2>
            <p class="text-gray-400 text-lg mb-6">
              A modern wrapper around Claude Agent SDK with rich UI and multi-device access
            </p>
          </div>
          <div class="text-sm text-gray-400 mb-6 space-y-2">
            <p>✨ Real-time message streaming</p>
            <p>🛠️ Tool calls and thinking process visualization</p>
            <p>📁 File system integration and workspace management</p>
            <p>💬 Multi-session support with persistent history</p>
          </div>
          <p class="text-gray-500 text-sm">
            Select a session from the sidebar or create a new one to start chatting
          </p>
        </div>
      </div>
    );
  }

  return <ChatContainer sessionId={currentSessionIdSignal.value} />;
}
