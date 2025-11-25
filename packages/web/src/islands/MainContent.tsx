import { currentSessionIdSignal } from "../lib/signals.ts";
import { sessions } from "../lib/state.ts";
import ChatContainer from "./ChatContainer.tsx";
import RecentSessions from "../components/RecentSessions.tsx";

export default function MainContent() {
  // For Preact Signals to track dependencies, we must access .value in the return statement
  // Accessing it in console.log or const assignment doesn't establish the subscription
  return (
    <>
      {!currentSessionIdSignal.value ? (
        <RecentSessions sessions={sessions.value} />
      ) : (
        <ChatContainer sessionId={currentSessionIdSignal.value} />
      )}
    </>
  );
}
