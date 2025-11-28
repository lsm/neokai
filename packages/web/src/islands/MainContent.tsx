import { currentSessionIdSignal } from "../lib/signals.ts";
import { sessions } from "../lib/state.ts";
import ChatContainer from "./ChatContainer.tsx";
import RecentSessions from "../components/RecentSessions.tsx";

export default function MainContent() {
  const sessionId = currentSessionIdSignal.value;
  const sessionsList = sessions.value;

  // Validate that the current session actually exists in the sessions list
  // (handles case where session is deleted in another tab)
  const sessionExists = sessionId && sessionsList.some(s => s.id === sessionId);

  return (
    <>
      {!sessionId || !sessionExists ? (
        <RecentSessions sessions={sessionsList} />
      ) : (
        <ChatContainer sessionId={sessionId} />
      )}
    </>
  );
}
