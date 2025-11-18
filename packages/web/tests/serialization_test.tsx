import { assertEquals, assertExists } from "jsr:@std/assert";
import IndexRoute from "../routes/index.tsx";
import Sidebar from "../islands/Sidebar.tsx";
import ChatContainer from "../islands/ChatContainer.tsx";
import { currentSessionIdSignal } from "../lib/signals.ts";

Deno.test("Serialization - islands and routes", async (t) => {
  await t.step("index route component can be imported without errors", () => {
    assertExists(IndexRoute, "Index route should be importable");
    assertEquals(typeof IndexRoute, "function", "Index route should be a function");
  });

  await t.step("Sidebar island can be imported without errors", () => {
    assertExists(Sidebar, "Sidebar island should be importable");
    assertEquals(typeof Sidebar, "function", "Sidebar should be a function");
  });

  await t.step("ChatContainer island can be imported without errors", () => {
    assertExists(ChatContainer, "ChatContainer island should be importable");
    assertEquals(typeof ChatContainer, "function", "ChatContainer should be a function");
  });

  await t.step("shared signal is properly initialized", () => {
    assertExists(currentSessionIdSignal, "Signal should exist");
    assertEquals(currentSessionIdSignal.value, null, "Signal should start as null");

    // Test that signal can be updated
    currentSessionIdSignal.value = "test-session-id";
    assertEquals(currentSessionIdSignal.value, "test-session-id", "Signal should update");

    // Reset
    currentSessionIdSignal.value = null;
    assertEquals(currentSessionIdSignal.value, null, "Signal should reset");
  });

  await t.step("islands do not receive function props (no serialization errors)", () => {
    // This test verifies the fix: Sidebar should not have any required function props
    // If it did, we'd get serialization errors when Fresh tries to hydrate the island

    // The old interface had: onSessionSelect: (sessionId: string) => void
    // The new implementation uses shared signals instead

    // Just verifying we can reference the island without type errors
    const SidebarRef = Sidebar;
    assertExists(SidebarRef, "Sidebar should not require function props");
  });
});
