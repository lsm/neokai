import { define } from "../utils.ts";
import Sidebar from "../islands/Sidebar.tsx";
import ChatContainer from "../islands/ChatContainer.tsx";
import ToastContainer from "../islands/ToastContainer.tsx";
import { currentSessionIdSignal } from "../lib/signals.ts";

export default define.page(function Home() {
  return (
    <>
      <div class="flex h-screen overflow-hidden bg-dark-950">
        {/* Sidebar */}
        <Sidebar />

        {/* Main Content */}
        {currentSessionIdSignal.value
          ? <ChatContainer sessionId={currentSessionIdSignal.value} />
          : (
            <div class="flex-1 flex items-center justify-center bg-dark-900">
              <div class="text-center px-6">
                <div class="mb-6">
                  <div class="text-6xl mb-4">🤖</div>
                  <h2 class="text-3xl font-bold text-gray-100 mb-3">
                    Welcome to Liuboer
                  </h2>
                  <p class="text-gray-400 text-lg mb-2">
                    Select a session or create a new one to get started
                  </p>
                </div>
                <div class="text-sm text-gray-500 space-y-1">
                  <p>A modern wrapper around Claude Agent SDK</p>
                  <p>with rich UI and multi-device access</p>
                </div>
              </div>
            </div>
          )}
      </div>

      {/* Global Toast Container */}
      <ToastContainer />
    </>
  );
});
