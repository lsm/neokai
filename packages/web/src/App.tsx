import { useEffect } from "preact/hooks";
import { effect, batch } from "@preact/signals";
import Sidebar from "./islands/Sidebar.tsx";
import MainContent from "./islands/MainContent.tsx";
import ToastContainer from "./islands/ToastContainer.tsx";
import { ConnectionOverlay } from "./components/ConnectionOverlay.tsx";
import { connectionManager } from "./lib/connection-manager.ts";
import { initializeApplicationState } from "./lib/state.ts";
import { currentSessionIdSignal } from "./lib/signals.ts";
import { initSessionStatusTracking } from "./lib/session-status.ts";
import { globalStore } from "./lib/global-store.ts";
import { sessionStore } from "./lib/session-store.ts";
import {
  initializeRouter,
  navigateToSession,
  navigateToHome,
  createSessionPath,
} from "./lib/router.ts";

export function App() {
  useEffect(() => {
    // STEP 1: Initialize URL-based router BEFORE any state management
    // This ensures we read the session ID from URL on page load
    const initialSessionId = initializeRouter();
    console.log(
      "[App] Router initialized with session:",
      initialSessionId || "none",
    );

    // STEP 2: Initialize state management when app mounts
    const init = async () => {
      try {
        // Wait for MessageHub connection to be ready
        const hub = await connectionManager.getHub();

        // Initialize new unified stores (Phase 3 migration)
        await globalStore.initialize();
        console.log("[App] GlobalStore initialized successfully");

        // Initialize legacy state channels (will be removed in Phase 5)
        // Pass initialSessionId so state channels know the URL state
        await initializeApplicationState(hub, currentSessionIdSignal);
        console.log("[App] Legacy state management initialized successfully");

        // Initialize session status tracking for sidebar live indicators
        initSessionStatusTracking();
        console.log("[App] Session status tracking initialized");

        // Sync currentSessionIdSignal with sessionStore.select()
        // This bridges the old signal-based approach with the new store
        effect(() => {
          const sessionId = currentSessionIdSignal.value;
          sessionStore.select(sessionId);
        });

        // STEP 3: After connection is ready, restore session from URL
        // If the URL has a session ID, set it in the signal
        // This is done AFTER state is initialized to ensure proper syncing
        if (initialSessionId) {
          console.log("[App] Restoring session from URL:", initialSessionId);
          batch(() => {
            currentSessionIdSignal.value = initialSessionId;
          });
        }
      } catch (error) {
        console.error("[App] Failed to initialize state management:", error);
      }
    };

    init();

    // STEP 4: Sync URL when session changes from external sources
    // (e.g., session created/deleted in another tab)
    // This effect watches for signal changes and updates the URL
    return effect(() => {
      const sessionId = currentSessionIdSignal.value;
      const currentPath = window.location.pathname;
      const expectedPath = sessionId ? createSessionPath(sessionId) : "/";

      // Only update URL if it's out of sync
      // This prevents unnecessary history updates and loops
      if (currentPath !== expectedPath) {
        if (sessionId) {
          navigateToSession(sessionId, true); // replace=true to avoid polluting history
        } else {
          navigateToHome(true);
        }
      }
    });
  }, []);

  return (
    <>
      <div
        class="flex h-dvh overflow-hidden bg-dark-950 relative"
        style={{ height: "100dvh" }}
      >
        {/* Sidebar */}
        <Sidebar />

        {/* Main Content */}
        <MainContent />
      </div>

      {/* Global Toast Container */}
      <ToastContainer />

      {/* Connection Overlay - blocks UI when disconnected */}
      <ConnectionOverlay />
    </>
  );
}
