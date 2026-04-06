# Make Room Tabs URL-Addressable with On-Demand Data Loading

## Goal

Make all room tabs addressable via URL (`/room/:id/tasks`, `/room/:id/goals`, etc.) and load LiveQuery data only when the relevant tab is active. This improves deep-linking, browser history navigation, and reduces unnecessary data fetching.

## Approach

1. Add route patterns and navigation functions for each room tab sub-path in the router
2. Update `handlePopState` and `initializeRouter` to parse tab from URL and set `currentRoomActiveTabSignal`
3. Replace local `useState<RoomTab>` in Room.tsx with signal-driven tab state from the URL
4. Migrate all callers of `currentRoomTabSignal` (the transient pending-tab signal) to use the new `navigateToRoomTab` function
5. Split `subscribeRoom` in room-store into per-query subscribe/unsubscribe methods so goals and skills LiveQueries only run when their tab is active
6. Add `lazy()` + `Suspense` code-splitting for GoalsEditor, RoomAgents, and RoomSettings

## Milestones

1. **Router: Add room tab routes and navigation** -- Add route patterns, path creators, extractors, `navigateToRoomTab`, and update `handlePopState`/`initializeRouter`/`getRoomIdFromPath`
2. **Room.tsx: Drive tab state from URL** -- Replace `useState` with `currentRoomActiveTabSignal`, update tab click handlers and all cross-file callers (BottomTabBar, RoomDashboard, TaskHeader, RoomContextPanel)
3. **Conditional LiveQuery subscriptions** -- Split `subscribeRoom` into per-query methods, make goals/skills subscriptions conditional on active tab
4. **Code-splitting with lazy/Suspense** -- Lazy-load GoalsEditor, RoomAgents, RoomSettings behind `Suspense` boundaries

## Design Notes

- **Overview tab has no URL sub-path.** `/room/:id` maps to the overview tab. There is no `/room/:id/overview` route. This means `navigateToRoomTab(id, 'overview')` delegates to `navigateToRoom` and does not add an `/overview` segment. Bookmarking the overview tab and bookmarking the root room URL are identical.
- **Chat tab uses the existing `/room/:id/agent` route.** `navigateToRoomTab(id, 'chat')` delegates to `navigateToRoomAgent`. No new `/room/:id/chat` route is added.
- **Tab navigation uses `pushState` (not `replaceState`)** to match `navigateToRoomAgent` behavior. This means browser back/forward navigates between tabs.
- **`navigateToRoom` does not set `currentRoomActiveTabSignal`** (intentional existing invariant). `navigateToRoomTab` handles setting the signal explicitly after delegation.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (needs `navigateToRoomTab` and tab route patterns)
- Milestone 3 depends on Milestone 2 (needs `currentRoomActiveTabSignal` driven by URL to know which tab is active)
- Milestone 4 is independent and can run in parallel with Milestone 3

## Total Estimated Tasks

7 tasks across 4 milestones
