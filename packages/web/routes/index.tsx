import { define } from "../utils.ts";
import Sidebar from "../islands/Sidebar.tsx";
import ChatContainer from "../islands/ChatContainer.tsx";
import { currentSessionIdSignal } from "../lib/signals.ts";

export default define.page(function Home() {
  return (
    <div class="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      {currentSessionIdSignal.value
        ? <ChatContainer sessionId={currentSessionIdSignal.value} />
        : (
          <div class="flex-1 flex items-center justify-center bg-gray-50">
            <div class="text-center">
              <h2 class="text-2xl font-bold text-gray-900 mb-2">
                Welcome to Liuboer
              </h2>
              <p class="text-gray-500 mb-6">
                Select a session or create a new one to get started
              </p>
              <div class="text-sm text-gray-400">
                <p>A modern wrapper around Claude Agent SDK</p>
                <p class="mt-1">with rich UI and multi-device access</p>
              </div>
            </div>
          </div>
        )}
    </div>
  );
});
