import { signal, effect } from "@preact/signals";
import type { Session } from "@liuboer/shared";

// Load persisted session ID from localStorage
const loadSessionId = (): string | null => {
  try {
    return localStorage.getItem("currentSessionId");
  } catch (err) {
    console.error("Failed to load session ID from localStorage:", err);
    return null;
  }
};

// Shared signal for the current session ID - initialize from localStorage
export const currentSessionIdSignal = signal<string | null>(loadSessionId());

// Persist session ID changes to localStorage
effect(() => {
  try {
    const sessionId = currentSessionIdSignal.value;
    if (sessionId) {
      localStorage.setItem("currentSessionId", sessionId);
    } else {
      localStorage.removeItem("currentSessionId");
    }
  } catch (err) {
    console.error("Failed to persist session ID to localStorage:", err);
  }
});

// Shared signal for sidebar open/closed state on mobile
export const sidebarOpenSignal = signal<boolean>(false);

// Shared signal for all sessions
export const sessionsSignal = signal<Session[]>([]);
