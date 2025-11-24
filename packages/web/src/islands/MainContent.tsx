import { currentSessionIdSignal } from "../lib/signals.ts";
import { sessions } from "../lib/state.ts";
import ChatContainer from "./ChatContainer.tsx";
import RecentSessions from "../components/RecentSessions.tsx";

export default function MainContent() {
  console.log("MainContent rendering, sessionId:", currentSessionIdSignal.value);

  // Use reactive state signals - component will re-render when these change
  const currentSessionId = currentSessionIdSignal.value;
  const sessionsList = sessions.value;

  if (!currentSessionId) {
    return <RecentSessions sessions={sessionsList} />;
  }

  return <ChatContainer sessionId={currentSessionId} />;
}
