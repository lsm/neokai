import { currentSessionIdSignal } from "../lib/signals.ts";
import ChatContainer from "./ChatContainer.tsx";

export default function MainContent() {
  const sessionId = currentSessionIdSignal.value;

  console.log("MainContent rendering, sessionId:", sessionId);

  if (!sessionId) {
    return (
      <div class="flex-1 flex items-center justify-center bg-dark-900">
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

  return <ChatContainer sessionId={sessionId} />;
}
