import { currentSessionIdSignal } from "../lib/signals.ts";
import { sessions } from "../lib/state.ts";
import ChatContainer from "./ChatContainer.tsx";
import RecentSessions from "../components/RecentSessions.tsx";

export default function MainContent() {
  // IMPORTANT: Access .value directly in component body to enable Preact Signals auto-tracking
  // The @preact/preset-vite plugin will transform this to create proper subscriptions
  const sessionId = currentSessionIdSignal.value;
  const sessionsList = sessions.value;

  console.log("[MainContent] Rendering with sessionId:", sessionId);
  console.log("[MainContent] Sessions list length:", sessionsList.length);

  // Validate that the current session actually exists in the sessions list
  // (handles case where session is deleted in another tab)
  const sessionExists =
    sessionId && sessionsList.some((s) => s.id === sessionId);

  console.log("[MainContent] Session exists:", sessionExists);

  if (!sessionId || !sessionExists) {
    console.log("[MainContent] Showing RecentSessions");
    return <RecentSessions sessions={sessionsList} />;
  }

  console.log("[MainContent] Showing ChatContainer for session:", sessionId);
  return <ChatContainer key={sessionId} sessionId={sessionId} />;
}
