import { signal } from "@preact/signals";

// Shared signal for the current session ID
export const currentSessionIdSignal = signal<string | null>(null);

// Shared signal for sidebar open/closed state on mobile
export const sidebarOpenSignal = signal<boolean>(false);
