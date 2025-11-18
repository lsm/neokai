import { signal } from "@preact/signals";

// Shared signal for the current session ID
export const currentSessionIdSignal = signal<string | null>(null);
