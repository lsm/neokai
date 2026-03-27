# Space UI/UX Audit — Overview

## Goal

Identify and fix UI/UX gaps in the Space feature based on a comprehensive code audit and analysis of the live application's components, routing, data flow, and existing E2E test coverage.

## Audit Methodology

This audit was conducted through:
1. Deep code review of all Space-related frontend components, stores, and routing
2. Review of all Space-related daemon RPC handlers and data models
3. Analysis of existing E2E tests (space-creation, space-happy-path-pipeline, space-approval-gate-rejection, space-export-import, space-workflow-rules, space-multi-agent-editor, space-agent-centric-workflow)
4. Running the dev server and verifying the SPA renders at http://localhost:8989
5. Cross-referencing the SpaceDashboard TODO comments and space-store stub methods

## Audit Findings Summary

### What Works (Confirmed via Code + E2E Tests)

1. **Navigation**: NavRail "Spaces" button navigates to `/spaces`, ContextPanel shows SpaceContextPanel with space thread list, filter tabs (active/archived), and "Create Space" button
2. **Space Creation**: SpaceCreateDialog renders in a modal with workspace path (auto-suggests name from basename), name, description fields; submits via `space.create` RPC; navigates to `/space/:id` on success
3. **Space Detail Layout**: SpaceIsland renders 4-tab view (Dashboard, Agents, Workflows, Settings) with tab bar; right column shows SpaceTaskPane when a task ID is in the URL
4. **Dashboard Tab**: SpaceDashboard shows space header (name, truncated workspace path, description), active status banner, Quick Actions cards, and recent activity list
5. **Agents Tab**: SpaceAgentList shows agent cards with role badges, model info, tool chips; supports create/edit/delete with SpaceAgentEditor modal; delete-blocking when agent is referenced by workflows
6. **Workflows Tab**: WorkflowList shows workflow cards with mini step visualization, step count, tags; supports create/edit/delete/export per card; import/export-all toolbar; list and visual editor modes with toggle
7. **Workflow Editor**: Both list-mode (WorkflowEditor) and visual-mode (VisualWorkflowEditor) are fully implemented with node config, edge config, gate config, rules editor
8. **Settings Tab**: SpaceSettings shows space metadata (name, description, workspace path, status, ID, created date) and Export Bundle button
9. **WorkflowCanvas**: SVG-based canvas with runtime mode (live task status) and template mode (editable gates); gate artifacts view for human approval
10. **SpaceTaskPane**: Full task detail pane with status badge, priority, workflow step indicator, description, current step, progress bar, result, error, PR link, and human input area for needs_attention tasks
11. **SpaceContextPanel**: Thread-style navigation with collapsible spaces, nested active tasks, task status dots, navigate-to-space arrows
12. **Real-time Updates**: SpaceStore subscribes to space.*, spaceAgent.*, spaceWorkflow.*, space.task.*, space.workflowRun.* events for live state sync
13. **Export/Import**: Full bundle export/import with preview dialog and conflict resolution
14. **Space Store**: Complete CRUD methods for spaces, tasks, agents, workflows, and workflow runs; promise-chain locking for atomic space switching; slug-to-UUID resolution

### What's Broken or Has Issues

| # | Issue | Severity | Location |
|---|-------|----------|----------|
| B1 | Quick Actions "Start Workflow Run" and "Create Task" buttons are unwired scaffolding — `onStartWorkflow` and `onCreateTask` props are never passed from SpaceIsland | P1 | `SpaceIsland.tsx` line 241, `SpaceDashboard.tsx` line 149 comment |
| B2 | SpaceNavPanel component is built but NOT rendered anywhere — SpaceIsland uses a tab-based layout without a left navigation column | P2 | `SpaceNavPanel.tsx` is imported nowhere except its own file |
| B3 | `spaceWorkflowRun.create` RPC handler may not be registered — store method has a TODO(M6) comment saying it's a stub | P1 | `space-store.ts` line 847 |
| B4 | SpaceAgentList has no padding wrapper — the component starts with `<div class="flex flex-col h-full">` but header uses `mb-4` without outer padding, while other tabs (Dashboard, Settings) use `p-6` | P3 | `SpaceAgentList.tsx` line 194 |
| B5 | SpaceContextPanel uses a rocket emoji in empty state which conflicts with the project's no-emoji rule | P3 | `SpaceContextPanel.tsx` line 262 |

### What's Missing from the User Journey

| # | Gap | Severity | Description |
|---|-----|----------|-------------|
| G1 | No space edit/rename UI | P2 | SpaceSettings shows metadata read-only; no inline edit for name/description. The `spaceStore.updateSpace()` method exists but no UI invokes it |
| G2 | No space delete/archive UI | P2 | No delete or archive buttons in Settings or anywhere. The store methods `archiveSpace()` and `deleteSpace()` exist but no UI invokes them |
| G3 | No standalone task creation UI | P1 | Dashboard "Create Task" button is unwired. No dialog/form exists for creating a standalone task despite `spaceStore.createTask()` being implemented |
| G4 | No workflow run start UI from dashboard | P1 | Dashboard "Start Workflow Run" button is unwired. No dialog exists for selecting a workflow and starting a run despite `spaceStore.startWorkflowRun()` being implemented |
| G5 | No chat interface within space detail | P2 | SpacesPage (the `/spaces` route) renders a ChatContainer for the Global Spaces Agent, but individual space views have no chat/agent interaction panel |
| G6 | Deep links for space sessions not fully connected | P3 | Router defines `/space/:id/session/:sessionId` pattern and `navigateToSpaceSession()` but SpaceIsland doesn't handle session sub-routes — only task sub-routes are handled via `currentSpaceTaskIdSignal` |
| G7 | No task status transition UI in task pane | P2 | SpaceTaskPane only shows "Human Input Required" for `needs_attention` status. No buttons to manually mark tasks as completed, cancelled, or change priority |
| G8 | No mobile/responsive consideration for space detail | P3 | WorkflowCanvas is hidden on mobile (`hidden md:flex`), Dashboard fallback shows, but tab content like Agents and Workflows has no mobile-specific layout adjustments |
| G9 | No breadcrumb or back navigation from space detail | P2 | When viewing `/space/:id`, there's no visible breadcrumb trail or back button to return to the spaces list (relies on NavRail + ContextPanel) |
| G10 | Workflow run history/logs not visible | P2 | Recent activity in dashboard shows run titles and status but no way to view run details, logs, or task breakdown for a specific run |

## Prioritized Improvement Plan

### P0 (Critical) — None identified

### P1 (High) — Wire up core user actions
- Wire Quick Actions buttons (Start Workflow Run, Create Task)
- Create Task creation dialog
- Create Workflow Run start dialog
- Verify and fix `spaceWorkflowRun.create` RPC registration

### P2 (Medium) — Complete the user journey
- Add space edit/rename functionality in Settings
- Add space delete/archive UI with confirmation
- Add task status management controls in SpaceTaskPane
- Add breadcrumb/back navigation for space detail
- Add workflow run detail view with task breakdown
- Consider chat integration for space detail view

### P3 (Low) — Polish
- Fix SpaceAgentList padding consistency
- Remove emoji from SpaceContextPanel empty state
- Improve mobile responsiveness
- Connect space session sub-routes

## Milestones

1. **Wire Quick Actions and Create Task Dialog** — Connect existing dashboard buttons and build the task creation form
2. **Workflow Run Start Dialog and RPC Verification** — Build the workflow run start UI and verify backend support
3. **Space Settings CRUD** — Add edit, archive, and delete functionality to SpaceSettings
4. **Task Pane Enhancements** — Add task status management and workflow run detail view
5. **Navigation and Polish** — Breadcrumbs, padding fixes, mobile improvements, emoji removal

## Estimated Task Count

Total: 14 tasks across 5 milestones
