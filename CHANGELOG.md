# Changelog

All notable changes to NeoKai will be documented in this file.

## [0.11.0] - 2026-04-22

A refinement release improving workflow reliability, artifact display, and communication resilience. 15 commits since v0.10.0.

### Added

**Space Workflow System**
- **Stacked PR task chain**: Plan & Decompose workflow generates ordered tasks with branch name, base branch, and dependency instructions for bottom-up PR chains
- **Data-driven artifact rendering**: Worktree commit display for artifacts
- **Unified save_artifact tool**: Consolidated `save`, `write_artifact`, and `report_result` into one tool
- **Clickable overview stat cards**: Navigate to tasks page from overview stats

**Frontend & UI**
- **Compact approval banners**: One-line + modal pattern replaces inline banners

### Fixed

- **Node-agent MCP tools**: Restored in workflow sessions after daemon restart; auto-resume idle sessions when messages are queued
- **Gate scripts**: Resolved from live templates instead of stale DB rows; startup drift warnings added
- **Communication**: `list_peers` shows topology peers; `send_message` queues for inactive nodes instead of failing
- **db-query MCP**: Exposed `space_sessions` and `sdk_messages` in space scope

## [0.10.0] - 2026-04-21

A focused release hardening the Space Workflow System for production use — autonomy enforcement, completion pipelines, workflow template sync, and significant UI polish. 76 commits since v0.9.0.

### Added

#### Space Workflow System
- **Stacked PR task chain**: Plan & Decompose Task Dispatcher embeds branch name, base branch, and dependency ordering instructions in each task description so downstream coders automatically produce a reviewable PR chain bottom-up from `dev`
- **Completion actions pipeline**: `script`, `instruction`, and `mcp_call` completion actions with audit trail, approval reason tracking, pause/resume flow, and `task_awaiting_approval` events
- **Autonomy-gated approvals**: Supervisor/semi-autonomous enforcement for workflow gates; "X of Y workflows autonomous" selector in SpaceSettings and SpaceOverview
- **Runtime controls**: Pause/resume lifecycle; Stop/Start runtime on overview page
- **Task dependency enforcement**: Cycle detection and failure cascade for dependent tasks
- **LLM-driven workflow selection**: Space chat agent auto-selects workflows for standalone tasks
- **Target any workflow node**: `send_message_to_task` auto-spawns and activates nodes across the workflow graph
- **Workflow template sync**: Drift detection with confirmation UI
- **Channel topology hardening**: Queue-until-active behavior; Task→Space escalation for unreachable targets
- **Workflow run artifacts**: Persisted artifacts per run with `GateArtifactsView` and `FileDiffView`
- **Reason-aware blocked tasks**: Blocked-task banner with gate approval UI and reason-based grouping
- **Approval audit trail**: `SpaceApprovalSource` tracking with `approvalReason` and thread events
- **Sessions page**: New Sessions list page and tab
- **Attention LiveQuery**: Action tab with reason-based grouping for tasks needing attention

#### Frontend & UI
- **URL-addressable Space views**: Overlay history, `/settings` route, slug-based routing
- **Redesigned SyntheticMessageBlock**: Markdown rendering, subtle card style, collapsible sections
- **Glass-style chat composer**: Multiline-aware bottom padding
- **Compact task thread**: Config-switchable compact renderer, cleaner agent headers, clickable hidden-message dividers
- **ThreadedChatComposer replaced with ChatComposer** in task view
- **Space chat agent**: Removed edit/write tools for cleaner agent boundaries

#### Performance
- **Background job queue + cache** for artifact git operations
- **Server-side slicing** of `spaceTaskMessages.byTask` for compact view

### Changed
- Replaced Full-Cycle with **Plan & Decompose** built-in workflow
- `report_result` now result-only; completion pipeline is sole status arbiter
- Split `report_result` into audit/approve/submit to end reviewer-loop premature completion
- Reorganized agent task message with injected runtime context
- Native `getContextUsage()` replacing `/context` text parsing
- Migration M86 early-return skips `pending_checkpoint_type` on pre-migrated DBs
- LiveQuery migration for ChatContainer + widened `space-agent-tools` to all Space sessions
- Lazy-load heavy deps, inline workspace selection in chat container, improve `/spaces` page UX

### Fixed

- **Reviewer loop**: Split report_result into audit/approve/submit to prevent premature completion; review-posted-gate falls back to PR comments when formal review is blocked
- **Space communication**: Keep node-agent sessions reachable until task is archived; allow communication until task is archived; @mention routing includes idle agents
- **Space workflow**: Persist `completionActions` and backfill workflow template tracking; gate banners only show after activation
- **Sessions**: Resume SDK sessions across workspace/worktree path changes; session error layout and retry button
- **Runtime**: Node-agent injection invariant + agent-callable restore; model switch stability
- **Mobile/iOS**: Compact Task Agent node on mobile canvas; standardize panel header heights and fix mobile Safari bottom gap
- **Copilot**: Call `client.start()` before caching CopilotClient

### CI

- E2E removed from all automatic CI triggers (workflow_dispatch only)
- Run lint/unit/online tests on push to dev
- Remove broken Microsoft apt repos before `apt-get update`

## [0.9.0] - 2026-04-20

A major release introducing the **Space Workflow System** — a multi-agent orchestration platform with visual workflow editing, channel-based routing, approval gates, and autonomy levels. ~1,145 commits since v0.8.0.

### Added

#### Space Workflow System
- **Visual workflow editor**: Drag-and-drop canvas with DAG auto-layout, zoom/pan controls, multi-select, node/edge config panels, per-slot agent overrides, and SVG edge rendering
- **Channel + Gate topology**: Separated `WorkflowChannel` (routing) and `Gate` (policy) types; unified `channels` column; gate scripts with restricted execution env; gate label/color/script-indicator UI
- **Built-in workflows**: Coding, Coding+QA, Research, Review-Only, and Plan & Decompose (replacing Full-Cycle); workflow template sync with drift detection and confirmation UI
- **LLM-driven workflow selection**: Space chat agent auto-selects workflows for standalone tasks; `suggest_workflow` MCP tool; configurable per-space tiebreaker
- **Task Agent**: First-class node with `send_message`, `list_reachable_agents`, `list_group_members`, `report_done`, `idle`/`save`/auto-gate-write primitives; worktree isolation via `SpaceWorktreeManager`; peer communication tools for node agents
- **Approval gates**: Backend RPCs, canvas/thread inline approval UI, reason-based blocked-task banner, audit trail with `SpaceApprovalSource` tracking
- **Parallel node execution**: Shared gates enable parallel agent runs; iteration detection and capping in `WorkflowExecutor`; cyclic channel support
- **Workflow run artifacts**: Persisted artifacts per run with `GateArtifactsView` and `FileDiffView`
- **Runtime pause/resume**: Lifecycle controls on space overview; Stop/Start runtime button; force-stop stale session groups
- **Autonomy levels**: `supervised` vs `semi_autonomous` per workflow; "X of Y workflows autonomous" selector; autonomy-gated approvals
- **Coding Workflow V2**: Coder↔Reviewer loop hardening with PR-posted review comments and verification; explorer/fact-checker/tester sub-agents for planner, coder, and reviewer roles
- **Completion actions pipeline**: `script`, `instruction`, and `mcp_call` completion actions with audit trail, approval reason tracking, pause/resume flow, and `task_awaiting_approval` events
- **Space Sessions page**: New Sessions list page and tab; full-width task view with agent session navigation; slug-based URL routing; numeric per-space task IDs

#### Neo Agent
- Side-panel AI assistant with `Cmd+J` shortcut, slide-out panel with Chat, Activity, and Confirmation UI
- Query tools (rooms, spaces, workflows, goals, tasks, skills, MCP servers) and action tools (config, messaging, space/workflow, goal/task, Undo)
- Security tier system, `MessageOrigin` tracking, `ViaNeoIndicator` badge, signal-based `NeoStore` with LiveQuery
- Neo settings section and online conversation flow tests

#### Missions (Goal V2)
- **Measurable missions**: Structured metrics with adaptive replanning; metric history time-series
- **Recurring missions**: Cron scheduling with execution identity, manual trigger, and recovery
- **Semi-autonomous mode** for coder/general tasks
- Mission detail page with header, status sidebar, and main content sections; type-specific creation and detail views; "Goal" → "Mission" UI terminology rename

#### Skills & MCP Registry
- Global skills registry UI with per-room enablement overrides; built-in `playwright`, `playwright-interactive`, `chrome-devtools-mcp`, `web-search-mcp`, `fetch-mcp`, and `brave-search` seeds; async validation via `SKILL_VALIDATE` job queue
- Application-level MCP settings panel with per-room enablement; `AppMcpLifecycleManager`; reactive `mcp.registry.listErrors` RPC
- `db-query` MCP server: scoped read-only SQL access with validation layer

#### References System (`@`-mentions)
- File, folder, task, and goal resolvers with shared reference types
- `ReferenceAutocomplete` component, `useReferenceAutocomplete` hook, `MentionToken` rendering
- `@mention` routing to specific agents in task thread composer; scoped to workflow agents only
- File index service with polling-based cache refresh

#### Short IDs
- Human-readable IDs for tasks and goals (`task-123`, `goal-42`); `ShortIdAllocator` with atomic counter allocation; backfill migrations; short IDs accepted in RPC handlers and URLs with click-to-copy badges

#### Provider & Session
- **GitHub Copilot** as transparent `AgentSession` backend via embedded Anthropic-compatible server
- **Anthropic-compatible HTTP bridge** backed by `codex` app-server
- **GLM-5-Turbo** model support
- Provider-aware session creation, provider-grouped model picker with availability dots, provider badge in session status bar
- Explicit `(modelId, providerId)` pairs for deterministic routing; filter unauthenticated providers from picker
- Graceful degradation on provider unavailability; model switching in TaskView with auto-fallback on rate/usage limits
- OpenAI token refresh/login in settings for Codex
- Native `getContextUsage()` replacing `/context` text parsing

#### Frontend & UI
- **TaskViewV2**: Turn-based conversation view with `TurnSummaryBlock`, `RuntimeMessageRenderer`, `AgentTurnBlock`; client-side pagination; `ReadonlySessionChat` and `SlideOutPanel`
- **LiveQuery migration**: `ChatContainer`, `tasks.byRoom`, `goals.byRoom`, group messages, room skills, and task thread messages migrated to LiveQuery with stale-event guards and reconnect handling
- **Compact task thread**: Config-switchable compact renderer, cleaner agent headers, clickable hidden-message dividers, system:init cards, agent completion state indicators
- **Glass-style chat composer** with multiline-aware bottom padding
- **Mobile polish**: `BottomTabBar` with iOS-style navigation, room-specific bottom tabs, iOS Safari safe-area fix, compact Task Agent node on mobile canvas, redesigned mobile task view header
- **UI overhaul**: Room tab restructure, Agents redesign, visual consistency pass; Button/IconButton/NavIconButton unification; typography + prose refinements; design-tokens module
- **Inbox view**: Direct approve/reject from Inbox without TaskView navigation; semantic status borders; inline reject form
- **Goals editor**: Two-step create wizard, improved cards, metric progress bars, execution history
- **Task UX**: Action dropdown with complete/cancel dialogs, circular progress indicator, reactivate/archive actions, full manual task-status control, `TaskArtifactsPanel`, canvas mode toggle, blocked-reason display
- **`EntityStore<T>`** generic signal-based frontend store pattern; migrated `RoomStore`, `roomSkills`, and global skills
- Agent overlay chat panel, activity members list, workspace history, draft message auto-save with 200k char limit
- Workflow Rules Editor, Custom Agent List and Editor, Space export/import (backend + UI)

#### Backend Infrastructure
- **`ChannelRouter`** with lazy node activation, gate evaluation, and cyclic iteration tracking
- **Job queue** replacing `setInterval`/`queueMicrotask`: `room.tick`, `github.poll`, `session.titleGeneration`, `job_queue.cleanup`, `SKILL_VALIDATE`
- **`ReactiveDatabase`** threaded through managers and repositories; `notifyChange` hooks on `GoalRepository`, `TaskRepository`, `SessionGroupRepository`
- **Named-query registry** with column aliasing and JSON parsing; `liveQuery.subscribe`/`unsubscribe` RPC handlers
- `CompletionDetector` for all-agents-done detection; `NodeExecutionManager` and `node_executions` table
- `AppMcpLifecycleManager` with per-room enablement; room-scoped sessions guarded against missing workspace paths; `defaultPath` propagation and validation
- Live `DaemonHub` event bridging for `room.*`/`goal.*`/`task.*` updates via `StateManager`
- `NotificationSink` interface for Space Agent event injection

### Changed

- **Terminology**: `step` → `node` across storage, runtime, types, and UI; `slot_role` → `agent_name`; `Goal` → `Mission` in UI copy; "Room Agent" → "Coordinator"
- **Transitions removed**: Replaced legacy `WorkflowTransition` with gated channels; removed `advance()` in favor of agent-driven progression; dropped session group tables and `currentNodeId`
- **Task lifecycle**: `failed` state made non-terminal (messages + retry); `archived` status added; `cancelled` → `completed` transition allowed; `needs_attention` auto-revives on new message
- **Lazy loading**: `GoalsEditor`, `RoomAgents`, `RoomSettings`, and `/spaces` page loaded on demand
- **Parallelization**: Daemon unit test shard runner; split rpc online tests into 4 shards; split online space tests and cross-provider tests into 2 jobs each
- **Workflow auto-selection**: Simplified multi-agent space to explicit `workflowId` or AI auto-select only
- Leader gets `create_task`, task management tools, and verifies PR mergeability before `submit_for_review`
- `Config.workspaceRoot` is now optional; `--workspace` flag removed; default DB path with PID lock
- `report_result` now result-only; completion pipeline is sole status arbiter
- Server-side slicing of `spaceTaskMessages.byTask` for compact view

### Fixed

- **Space communication**: Keep node-agent sessions reachable until task is archived; node-agent injection invariant + agent-callable restore
- **Space workflow**: Persist `completionActions` and backfill workflow template tracking; space task review status handling; merge `listGateData` with event updates to prevent race
- **Mobile/iOS**: iOS Safari safe-area gap, bottom tab bar overlap, model dropdown overflow, pointer-event intercepts, `pb-bottom-bar` layout
- **Worktree**: Resolve Task Agent worktree path under `~/.neokai` instead of source repo; artifacts tab uses task worktree path for git diff
- **Sessions**: Resume SDK sessions across workspace/worktree path changes; show stop button in space session composer when agent is running; session error layout + retry button
- **Context**: Refresh context usage after `/compact` completes
- **Runtime**: Recover stuck leaders after rate-limit expiry; clear group rate limit on resume and message send; early return after successful fallback model switch
- **N+1 queries**: Fixed room/task loading queries; added missing DB indexes; parallelized subscriptions; bundled session info into `getGroup`
- **E2E**: Numerous E2E fixes for canvas-based channels, mission terminology, reference autocomplete, gate approval, happy-path pipeline, mobile duplicate overview, workspace selection, pointer events

### CI

- **E2E removed from all automatic triggers** — E2E must now be invoked via `workflow_dispatch` with `run_e2e_only=true`
- Suppressed Node.js 20 deprecation warning in GitHub Actions
- Enabled web tests on PRs to `dev` and fixed 28 pre-existing test failures
- Remove broken Microsoft apt repos before `apt-get update`
- Add `ripgrep` to CI and release sandbox dependencies
- Setup-devproxy composite action with caching; simplified CI by removing intermediate gate jobs

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
