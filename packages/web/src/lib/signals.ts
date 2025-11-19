import { signal } from "@preact/signals";
import type { Session } from "@liuboer/shared";

// Shared signal for the current session ID
export const currentSessionIdSignal = signal<string | null>(null);

// Shared signal for sidebar open/closed state on mobile
export const sidebarOpenSignal = signal<boolean>(false);

// Shared signal for all sessions
export const sessionsSignal = signal<Session[]>([]);
