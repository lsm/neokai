# Space UI/UX Redesign — Overview

## Goal

Redesign the Space UI to follow the same **three-column layout paradigm** (NavRail → ContextPanel → ContentPanel) used by the Room system, with a clear **two-layer interaction model**: Spaces List level and Individual Space level. Each layer defines what appears in the ContextPanel and ContentPanel, how agents are accessed, and how tasks are managed.

## Design Philosophy

The Room system provides the proven interaction pattern:
- **RoomContextPanel** (level 2) has: stats strip → pinned items (Dashboard, Room Agent) → collapsible sections (Missions, Tasks, Sessions)
- **Room ContentPanel** renders different views based on route: dashboard tabs (default), ChatContainer (session/agent view), TaskViewToggle (task view)
- Agent chat is a **first-class navigation target** (`/room/:id/agent`) accessed from the ContextPanel

Spaces should follow this exact paradigm, adapted for workflow-driven multi-agent orchestration.

## Audit Findings (from Live Testing)

### What Works (14 features confirmed)
1. NavRail "Spaces" button + SpaceContextPanel thread list
2. Space creation with auto-naming from workspace path
3. SpaceIsland tabbed layout (Dashboard/Agents/Workflows/Settings)
4. Agents CRUD with role badges, model info, delete-blocking
5. Workflow list + visual editor (list mode and visual mode)
6. Settings tab with metadata display
7. WorkflowCanvas (runtime + template modes)
8. SpaceTaskPane with task detail
9. SpaceContextPanel thread-style navigation
10. Real-time WebSocket event subscriptions
11. Export/Import with preview and conflict resolution
12. Space store with full CRUD + slug resolution
13. Workflow rules editor
14. Gate approval/rejection UI on WorkflowCanvas

### What's Broken
| # | Issue | Severity | Root Cause |
|---|-------|----------|------------|
| B1 | Quick Actions "Start Workflow Run" and "Create Task" are unwired scaffolding | P1 | `SpaceIsland.tsx` never passes `onStartWorkflow`/`onCreateTask` to `SpaceDashboard` |
| B2 | RPC naming mismatch: frontend calls `spaceWorkflowRun.create`, daemon registers `spaceWorkflowRun.start` | P1 | `space-store.ts:857` vs `space-workflow-run-handlers.ts:124`. TODO(M6) is stale |
| B3 | SpaceNavPanel built but never rendered | P2 | Component exists with tests/exports but isn't used; tab layout replaced left-panel nav |
| B4 | SpaceAgentList lacks padding consistency | P3 | No `p-6` wrapper like Dashboard and Settings tabs |
| B5 | Emoji in SpaceContextPanel + ContextPanel.tsx empty states | P3 | Rocket emoji violates no-emoji rule |

### What's Missing — The Core Gap

**The fundamental problem isn't individual bugs — it's that Spaces doesn't follow the Room system's two-layer interaction model.** Specifically:

1. **No Space Agent chat** — Rooms have "Room Agent" as a pinned item in RoomContextPanel with full ChatContainer. Spaces have no equivalent. Users can't converse with the space agent.
2. **No Space-level ContextPanel** — When inside a space, the ContextPanel still shows SpaceContextPanel (the global spaces list), not a space-specific panel with tasks, runs, and pinned items like RoomContextPanel.
3. **No route-driven content switching** — Room ContentPanel switches between dashboard/session/task views based on URL. SpaceIsland uses tabs + a side pane, which is a different and less consistent pattern.
4. **No task agent interaction** — Tasks have detail panes but no way to chat with the task's agent or view agent sessions.

## Two-Layer Design

### Layer 1: Spaces List (`/spaces`, no space selected)

| Column | Component | Content |
|--------|-----------|---------|
| **NavRail** | "Spaces" icon selected | Same as now |
| **ContextPanel** | `SpaceContextPanel` (existing) | Thread-style space list with expandable tasks, active/archived filter, "Create Space" button |
| **ContentPanel** | `SpacesPage` (existing) | `SpacesPage` is a thin wrapper that renders `<ChatContainer sessionId="spaces:global" />` — a full chat interface with the Global Spaces Agent |

**This layer already works correctly.** `SpacesPage` (at `packages/web/src/islands/SpacesPage.tsx`) renders ChatContainer with the pre-provisioned `spaces:global` session. The Global Spaces Agent can create/list/manage spaces via MCP tools.

### Layer 2: Individual Space (`/space/:id`, space selected)

| Column | Component | Content |
|--------|-----------|---------|
| **NavRail** | "Spaces" icon selected | Same |
| **ContextPanel** | **`SpaceDetailPanel`** (NEW) | Stats strip → Pinned (Dashboard, Space Agent) → Workflow Runs → Tasks → Sessions |
| **ContentPanel** | `SpaceIsland` (refactored) | Route-driven: Dashboard tabs (default), ChatContainer (agent/session), SpaceTaskPane (task) |

#### SpaceDetailPanel Design (mirrors RoomContextPanel)

```
┌─────────────────────────┐
│ 3 active · 1 review     │  ← Task stats strip
├─────────────────────────┤
│ 📊 Dashboard            │  ← Pinned: /space/:id
│ 💬 Space Agent          │  ← Pinned: /space/:id/agent
├─────────────────────────┤
│ ▼ Workflow Runs (2)     │  ← Collapsible section
│   ● Deploy v2.1 [run]   │    Active run with status dot
│     ├ Task: Build API    │    Nested tasks under run
│     └ Task: Write tests  │
│   ● Setup CI [done]     │    Completed run
├─────────────────────────┤
│ ▼ Tasks                 │  ← Collapsible, tab-filtered
│  [active] [review] [done]│
│   ● Standalone task 1   │    Tasks not linked to runs
├─────────────────────────┤
│ ▼ Sessions (3)       [+]│  ← Collapsible, default collapsed
│   ● Space Agent chat    │    The space:chat:{spaceId} session
│   ● Task: Build API     │    Task agent session (via taskAgentSessionId)
│   ● Manual session      │    User-created sessions within space
└─────────────────────────┘
```

**Sessions section contents:** Shows all sessions associated with the space:
1. The space agent session (`space:chat:{spaceId}`) — always present
2. Task agent sessions — sessions linked via `SpaceTask.taskAgentSessionId` (read-only, created by workflow execution)
3. Manually created sessions — any sessions the user creates within the space context

Note: `spaceStore` signals already handle real-time updates via WebSocket event subscriptions (`space.task.*`, `space.workflowRun.*`), so SpaceDetailPanel will automatically reflect live state changes without additional wiring.

#### ContentPanel Route Mapping

| Route | Content | Trigger |
|-------|---------|---------|
| `/space/:id` | Dashboard tabs (Dashboard/Agents/Workflows/Settings) | Click "Dashboard" in SpaceDetailPanel |
| `/space/:id/agent` | ChatContainer for space agent session | Click "Space Agent" in SpaceDetailPanel |
| `/space/:id/session/:sid` | ChatContainer for specific session | Click session in SpaceDetailPanel |
| `/space/:id/task/:tid` | SpaceTaskPane (full-width, not side pane) | Click task in SpaceDetailPanel |

### Agent Interaction Model

| Agent | How to Access | Session ID Pattern |
|-------|--------------|-------------------|
| **Global Spaces Agent** | SpacesPage (Level 1 ContentPanel) | `spaces:global` (pre-provisioned) |
| **Space Agent** | "Space Agent" pinned item in SpaceDetailPanel | `space:chat:{spaceId}` (mirrors `room:chat:{roomId}`) |
| **Task Agent** | "View Agent Session" button in full-width SpaceTaskPane | Via `SpaceTask.taskAgentSessionId` → navigates to `/space/:id/session/:taskAgentSessionId` |

**Task agent interaction**: `SpaceTask` already has `taskAgentSessionId?: string | null` (line 218 in `packages/shared/src/types/space.ts`) and `activeSession?: 'worker' | 'leader' | null` (line 204). When a task has a linked agent session, the full-width task view (M3) shows a "View Agent Session" button that navigates to `/space/:id/session/:taskAgentSessionId` — reusing the existing session route with ChatContainer. No new infrastructure needed.

The Space Agent chat enables users to:
- Ask about space status, task progress, workflow state
- Trigger actions conversationally ("start the deploy workflow", "create a task for...")
- Review and approve gate decisions
- Get summaries and reports

## Milestones

1. **SpaceDetailPanel + ContextPanel Switching** — Build the space-specific ContextPanel and wire ContextPanel.tsx to switch between SpaceContextPanel (level 1) and SpaceDetailPanel (level 2) based on `currentSpaceIdSignal` (2 tasks)
2. **Space Agent Chat** — Provision space agent session in daemon, add `navigateToSpaceAgent()` router function, wire SpaceIsland to render ChatContainer for agent/session views with props-based rendering, fix RPC naming mismatch (4 tasks)
3. **Route-Driven Content Switching** — Make task view full-width with "View Agent Session" button, verify all space sub-routes (2 tasks)
4. **Wire Quick Actions + Task Creation** — Connect dashboard buttons, build SpaceTaskCreateDialog and WorkflowRunStartDialog (3 tasks)
5. **Space Settings CRUD + Polish** — Add edit/archive/delete UI, fix padding, remove emojis, remove SpaceNavPanel, comprehensive E2E test (3 tasks)

### Dependency Graph

```
M1: Task 1.1 ──────┐
                    ├──→ M2: Task 2.3 ──→ M3: Task 3.1, 3.2 ──→ M5: Task 5.3
M2: Task 2.4 ──────┘
    Task 2.1 ──────────→ M2: Task 2.3
    Task 2.2 (independent) ──→ M4: Task 4.2

M4: Task 4.1 (independent)
M5: Task 5.1, 5.2 (independent)
```

- M1 Task 1.1 and M2 Task 2.4 must complete before M2 Task 2.3 (ChatContainer wiring needs SpaceDetailPanel + agent route)
- M2 Task 2.1 (daemon provisioning), Task 2.2 (RPC fix), and Task 2.4 (router) are independent — can start immediately
- M3 depends on M2 Task 2.3 completing (extends the content priority chain)
- M4 Tasks 4.1/4.2 are independent dialog components; Task 4.3 wires them
- M5 Tasks 5.1/5.2 are independent; Task 5.3 (E2E) depends on M1+M2+M3

## Estimated Task Count

Total: 14 tasks across 5 milestones (M1:2, M2:4, M3:2, M4:3, M5:3)

## Deferred to Future Iteration
- **Mobile responsiveness**: WorkflowCanvas hides on mobile but other views lack mobile layouts. SpaceDetailPanel will support mobile drawer close via `onNavigate` prop. Deferred as P3.
- **Workflow run detail view**: Drill-down into a run's task breakdown. Deferred until SpaceDetailPanel establishes the navigation pattern.
- **Task status management UI**: SpaceTaskPane currently shows task detail + "Human Input Required" form for `needs_attention` status. Adding explicit status transition buttons (mark complete, cancel, change priority) and task reassignment is deferred — the existing HumanInputArea already handles the primary `inputDraft` interaction flow.
- **Deep links for space sessions**: Session sub-routes exist in router but need SpaceIsland handling. Addressed in M3.
