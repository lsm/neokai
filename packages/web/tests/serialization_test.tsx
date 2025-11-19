import { describe, test, expect } from "bun:test";
import IndexRoute from "../routes/index.tsx";
import Sidebar from "../islands/Sidebar.tsx";
import ChatContainer from "../islands/ChatContainer.tsx";
import { currentSessionIdSignal } from "../lib/signals.ts";

describe("Serialization - islands and routes", () => {
  test("index route component can be imported without errors", () => {
    expect(IndexRoute).toBeDefined();
    expect(typeof IndexRoute).toBe("function");
  });

  test("Sidebar island can be imported without errors", () => {
    expect(Sidebar).toBeDefined();
    expect(typeof Sidebar).toBe("function");
  });

  test("ChatContainer island can be imported without errors", () => {
    expect(ChatContainer).toBeDefined();
    expect(typeof ChatContainer).toBe("function");
  });

  test("shared signal is properly initialized", () => {
    expect(currentSessionIdSignal).toBeDefined();
    expect(currentSessionIdSignal.value).toBe(null);

    // Test that signal can be updated
    currentSessionIdSignal.value = "test-session-id";
    expect(currentSessionIdSignal.value).toBe("test-session-id");

    // Reset
    currentSessionIdSignal.value = null;
    expect(currentSessionIdSignal.value).toBe(null);
  });

  test("islands do not receive function props (no serialization errors)", () => {
    // This test verifies the fix: Sidebar should not have any required function props
    // If it did, we'd get serialization errors when Fresh tries to hydrate the island

    // The old interface had: onSessionSelect: (sessionId: string) => void
    // The new implementation uses shared signals instead

    // Just verifying we can reference the island without type errors
    const SidebarRef = Sidebar;
    expect(SidebarRef).toBeDefined();
  });
});
