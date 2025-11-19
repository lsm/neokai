import { currentSessionIdSignal, sessionsSignal } from "../lib/signals.ts";
import ChatContainer from "./ChatContainer.tsx";
import RecentSessions from "../components/RecentSessions.tsx";

export default function MainContent() {
  console.log("MainContent rendering, sessionId:", currentSessionIdSignal.value);

  if (!currentSessionIdSignal.value) {
    return <RecentSessions sessions={sessionsSignal.value} />;
  }

  return <ChatContainer sessionId={currentSessionIdSignal.value} />;
}
