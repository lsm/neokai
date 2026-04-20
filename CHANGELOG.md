# Changelog

All notable changes to NeoKai will be documented in this file.

## [0.9.0] - 2026-04-20

Major release with a full overhaul of the Space Workflow system, a dedicated Mission detail page, a completion-actions pipeline, autonomy-aware gate approvals, a hardened Coder↔Reviewer loop, LiveQuery-driven chat rendering, and a large UI polish pass. ~1,100 non-merge commits since v0.8.0.

### Added

- **Space Workflow system overhaul**: Restructured built-in workflows into Coding, Coding+QA, Research, Review-Only, and the new Plan & Decompose workflow (replaces Full-Cycle) with detailed prompts, instructions, and per-node gates. Includes workflow template sync with drift detection and a confirmation UI, plus deletion of orphan built-in workflow rows.
- **LLM-driven workflow selection for standalone tasks**: New `create_standalone_task` flow with a `workflow_id` parameter and an LLM selector that picks the best workflow for the user's request.
- **Completion actions pipeline**: Workflow nodes can now chain `script`, `instruction`, and `mcp_call` actions on completion, with gate auto-approval and PR merge automation. Includes resume paths, `artifactRepo` wiring, audit trail (`approvalReason` + thread events), task-pane and overview surfacing of pending completion-action pauses, and a `task_awaiting_approval` event.
- **Autonomy level system**: 5-level numeric autonomy replacing the binary model, with per-workflow autonomy UI in `SpaceSettings` and `SpaceOverview`, an "X of Y workflows autonomous" summary on the autonomy selector, autonomy-gated approvals for workflow gates, and a per-approval source audit trail (`SpaceApprovalSource`).
- **Gate approval UX**: Gate approval is surfaced on the workflow canvas and in the task thread, with inline human-input questions, a reason-aware blocked-task banner, and a gate-rejection rejection flow.
- **Mission detail page**: New dedicated room-mission view with header, status sidebar, content sections, execution history, and routing (`navigateToRoomMission`, `mission` route, `useMissionDetailData` hook). Includes manual trigger and schedule controls for recurring missions and defensive JSON parsing for `schedule` / `structuredMetrics`.
- **Sessions list page and tab**: Room gets a dedicated Sessions listing and tab, plus an Action tab with reason-based grouping driven by attention LiveQuery.
- **Workflow run artifacts**: Per-run artifact storage surfaced in `TaskArtifactsPanel` with close control and correct worktree-based git diff resolution.
- **Coding workflow reviewer loop hardening**: Reviewer now posts to the PR and verifies, `report_result` is result-only with the completion pipeline as the sole status arbiter, and `idle` / `save` / auto-gate-write replace legacy `done` / `report_done` / `write_gate` primitives.
- **@mention system**: `@mention` autocomplete in the task thread composer with routing to specific agents, scoped to workflow agents only.
- **Agent overlay chat panel**: Per-agent overlay in Space sessions with activity members list and overlay click-through from `SpaceTaskPane`.
- **Task canvas mode toggle**: Toggle button in task view that unifies the task pane canvas with the visual workflow editor via a shared `readOnly` mode.
- **Manual task status control UI**: Full manual status control for tasks, plus blocked-reason display on task cards and task pane, block-reason tagging, and model switch stability fixes.
- **Task dependency enforcement**: Cycle detection and failure cascade across dependent tasks.
- **Runtime pause/resume lifecycle controls**: Runtime Stop/Start control surfaced on the overview page (limited to 5 recent items).
- **Workflow editor upgrades**: `endNodeId` support in visual and form workflow editors, override/expand mode selector in the node editor UI, legacy plain-string overrides and endNode in export/import, and workflow manager validation + node execution RPC handlers.
- **Send-message-to-task improvements**: Can target any node and auto-spawn when needed; node-agent injection invariant with agent-callable restore.
- **Node-execution model**: New `NodeExecutionManager` with `CompletionDetector` migrated to `node_executions`; workflow canvas node status now reads from `nodeExecutions`.
- **Workspace history for normal sessions**: Normal session creation remembers and surfaces recent workspaces.
- **db-query MCP server**: New scoped, read-only SQL MCP server injected into all agent session types.
- **Space Agent tools UI**: Cleans up session tools, removes Brave MCP, fixes Playwright skills, and adds Space Agent tools to the UI.
- **Glass-style chat composer**: Multiline-aware bottom padding and iOS safe-area handling; stop button surfaces in the Space session composer while an agent is running.
- **Compact task thread renderer**: Config-switchable compact renderer with cleaner agent headers, clickable hidden-message divider, and a server-side `spaceTaskMessages.byTask` slice for the compact view.
- **LiveQuery migration for ChatContainer**: `ChatContainer` messages are now driven by LiveQuery, and `space-agent-tools` is widened to all Space sessions.
- **Native context usage**: `/context` text parsing replaced with the SDK's native `getContextUsage()`; context usage refreshes after `/compact` completes.
- **UI demo library**: Large port of reference demos — 80 pure-HTML demos, 53 icon-only demos for lists/nav/data-display/app-shells, 47 Forms demos, 41 icon-only demos for elements/feedback/headings/layout/forms, 35 pure-HTML reference examples, 22 headless+icon overlay demos, stacked application shells, Command Palettes and Navbars, page composition demos, and a refactored demo sidebar with unique IDs, icon mapping, active highlighting, and search filter.
- **UI component polish**: New `ButtonGroup` component; `Toast` gains variant types, icon slot, and a progress bar; improved existing component APIs with demo examples for composable patterns.
- **Mobile and iOS Safari**: Safe-area gap fix, inline `BottomTabBar` on mobile, room bottom nav refresh, mobile model dropdown overflow fix with click-outside dismiss, compact Task Agent node on mobile canvas, and mobile-optimised task view header.
- **Seed agents hardening**: Partial-failure recovery for `seed-agents`.
- **Built-in workflow templates**: Detailed prompts/instructions, `endNodeId` support, `instructions` and `backgroundContext` editors in `SpaceSettings`.

### Changed

- **Workspace flag removed**: `--workspace` flag removed in favor of a default DB path with a PID lock file. Sessions resume across workspace/worktree path changes.
- **Room UI overhaul**: Tab restructure, Agents redesign, demo index page redesign, lazy loading for `GoalsEditor`, `RoomAgents`, and `RoomSettings`, `useRoomLiveQuery` is now tab-aware, `useState` replaced with signal-driven tabs in `Room.tsx`, and `room-store.subscribeRoom` split into per-query methods.
- **Terminology step → node**: Completed `step-agent` → `node-agent` rename and `step → node` renames across runtime comments, export format, and storage repositories.
- **Workflow infrastructure cleanup**: Removed `WorkflowTransition` and transition infrastructure, removed `relay_message` from Task Agent tools, and removed auto-recovery logic from the query runner.
- **Space entry UX**: Removed the global spaces agent and now shows space cards on `/spaces`; workspace selection moved inline in the chat container.
- **Performance**: Parallel shard runner for daemon unit tests; eliminated redundant queries on room entry and parallelised subscriptions; fixed N+1 queries and added missing DB indexes for room/task loading; lazy-loaded heavy deps on `/spaces`; bundled session info into `getGroup` and removed the header progress circle in task view; removed `emitTaskUpdate` and redundant `emitRoomOverview` calls.

### Fixed

- **Space communication and reachability**: Communication now allowed until the task is archived; node-agent sessions remain reachable until the task is archived; thread UI polish (agent header spacing, system:init card height, empty thinking blocks).
- **Completion actions persistence**: Persist `completionActions` and backfill workflow template tracking.
- **Planning tasks**: Prevent planning tasks from getting stuck in unrecoverable states; revive `in_progress` tasks with no active group instead of blocking.
- **SDK and model switching**: Deterministic subprocess exit wait prevents SDK startup timeout after model switch; merge `listGateData` result with event-based updates to eliminate race condition.
- **Mission terminology / routing**: Resolved mission-terminology E2E failures, mission-detail routing, re-fetch execution history when `goal.updatedAt` changes.
- **Artifacts and worktrees**: Artifacts tab no longer shows empty — uses the task worktree path for git diff; task agent worktree path now resolves under `~/.neokai` instead of the source repo.
- **Session UX**: Session error layout and broken retry button, duplicate Overview button in mobile layout.
- **SQLite cleanup**: Resolved SQLite teardown race condition in daemon cleanup.
- **E2E stability**: Many E2E fixes across reference autocomplete, space workflow flows, gate approval, workspace selection, canvas, task-message-streaming, space-happy-path-pipeline, room-sidebar-sections, task lifecycle, and neo-chat-rendering; `neo-chat-rendering` now runs serially to avoid cross-worker interference.
- **CLI**: Removed orphaned workspace-related tests in CLI.

### CI

- **E2E removed from automatic CI triggers**: E2E is no longer run on every PR; manual `workflow_dispatch` with `run_e2e_only=true` is used for targeted E2E runs on PR branches.
- **Web tests on PRs to `dev`**: Enabled web tests on PRs to `dev` and fixed 28 pre-existing test failures.
- **Online test matrix**: Split space online tests into 2 parallel jobs; split cross-provider online tests into 2 parallel jobs; split rpc online tests into 4 balanced shards; validated `rpc-task-draft-handlers` in matrix.
- **Pipeline simplification**: Removed intermediate gate jobs and extracted a reusable Dev Proxy setup action with caching.
- **Sandbox dependencies**: Added ripgrep to CI and release sandbox dependencies; removed broken Microsoft apt repos before `apt-get update`; suppressed Node.js 20 deprecation warning in GitHub Actions.

## [0.7.1] - 2026-03-15

### Fixed
- Updated `optionalDependencies` in `npm/neokai/package.json` to reference `0.7.1` platform binaries

## [0.7.0] - 2026-03-14

### Added
- **PR as first-class task data**: PR number, URL, and creation timestamp are now stored on tasks and surfaced in the UI with quick-access buttons in task view and task overview
- **Bypass markers for research/verification tasks**: Workers can now skip git/PR gates for research-only tasks using markers (`RESEARCH_ONLY:`, `VERIFICATION_COMPLETE:`, `INVESTIGATION_RESULT:`, `ANALYSIS_COMPLETE:`) as the first line of their final response — prevents unnecessary PRs for pure analysis work
- **Active session tracking**: Added `activeSession` field on tasks to display real-time working indicators (pulsing badges) without status thrashing when a human injects a message into a running session
- **SDK sub-agent architecture**: Added worker and leader sub-agents to avoid context overflow in long-running tasks; configurable via `room.config.agentSubagents`; built-in Tester sub-agent auto-included for coder agents; leader analysis helpers for read-only tasks; planner plan-writer sub-agent with scope-adaptive file structure
- **Task completion/cancellation UX redesign**: Replaced raw cancel button with a three-dot dropdown menu with `CompleteTaskDialog` and `CancelTaskDialog` modals (confirmation flow, optional summary/reason fields)
- **Stop/terminate sessions from task view**: Amber interrupt button in task view header to interrupt running worker or leader sessions mid-stream without changing task status
- **Dead loop detection**: Levenshtein similarity + count/time-based detection (5 failures / 5 min / 75% similarity) prevents infinite bounce cycles in runtime gates
- **Leader gets room-agent-tools**: Leader agent now has access to task/goal management tools via the `room-agent-tools` MCP server for dynamic plan adjustment

### Changed
- **Task status rename**: `failed` → `needs_attention` for clearer semantic meaning; UI tab labels and localStorage keys updated with backward compatibility
- **Planner workflow**: Planner now correctly creates PR and draft tasks before completing; added planning-specific post-approval workflow where the leader sends the planner back to run Phase 2 instead of merging directly

### Fixed
- **Question handling**: Tasks now pause (stay in `waiting_for_input`) when a worker or leader asks a question via `AskUserQuestion` instead of cancelling or routing to the next agent
- **Worker→Leader routing**: Fixed bug where worker finishes first round but gets stuck without triggering leader; added zombie group detection fix, silent routing failure logging, and `recoverStuckWorkers()` for automatic recovery
- **Real-time task status synchronization**: Fixed 7 room/goal DaemonHub events (`room.task.update`, `room.overview`, `room.runtime.stateChanged`, `goal.*`) not being forwarded to WebSocket clients; added event bridge in `StateManager`
- **State synchronization**: Fixed `submittedForReview` flag not being set on `set_task_status` → `review` transitions, and `resumeWorkerFromHuman` no longer incorrectly changes task to `in_progress` for approvals
- **PR mergeability checks**: Leader now validates PR health (merge conflicts, failing CI) before submitting for human review
- **Duplicate messages after restart**: Fixed race condition where tick loop ran before recovery completed, causing duplicate restart injection messages
- **Model field handling**: Fixed inconsistent model resolution in `buildLeaderHelperAgents` — now uses `resolveModelId`/`resolveProvider` helpers consistently with `buildReviewerAgents`
- **Removed `handoff_to_worker` no-op tool**: Removed legacy compatibility shim from leader agent; updated all prompts and tests
- **Auto-revive failed tasks**: Sending a message to a `needs_attention` task now auto-revives it to `review` status with sessions restored
- **Fail tasks on terminal API errors**: Tasks now fail immediately on terminal API errors instead of bouncing indefinitely

## [0.6.2] - 2026-03-13

### Fixed
- **Configuration**: Bumped patch version for dependency updates

## [0.6.1] - 2026-03-12

### Fixed
- **Configuration**: Fixed kai binary not using ANTHROPIC_BASE_URL from environment and settings.json
  - Preserve user's custom ANTHROPIC_BASE_URL from environment/settings
  - Clear ANTHROPIC_BASE_URL when not user-configured (use default)
  - Preserve all user-configured environment variables from settings.json
  - Improved code clarity and variable naming (renamed `originalBaseUrl` to `userConfiguredBaseUrl`)

## [0.6.0] - 2026-02-?? (date may vary)

### Added
- Enhanced session management and state synchronization
- Improved E2E test reliability with dev proxy

### Fixed
- Various bug fixes and improvements

## [0.5.2] - 2026-02-?? (date may vary)

### Fixed
- Bug fixes and improvements

## [0.5.1] - 2026-02-?? (date may vary)

### Fixed
- Bug fixes and improvements

## [0.5.0] - 2026-02-?? (date may vary)

### Added
- New features and improvements

## [0.4.0] - 2026-01-?? (date may vary)

### Added
- New features and improvements

## [0.3.0] - 2026-01-?? (date may vary)

### Added
- Initial release features
