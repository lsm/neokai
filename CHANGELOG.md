# Changelog

All notable changes to NeoKai will be documented in this file.

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
