# Appendix: Room Feature Parity Reference

> **Design Revalidation:** This appendix references Room system internals for cross-reference only. The main plan focuses on Space's end-to-end workflow execution. See `00-overview.md` for the milestone structure.

---

## Summary Parity Scores

| Dimension | Parity | Priority | Key Gap | Relevant Task |
|-----------|--------|----------|---------|--------------|
| Goal/Mission integration | 15% | CRITICAL | No active integration | Task 14, 15 |
| Error detection and recovery | 50% | HIGH | No error classification pipeline | Task 6 |
| Dead loop detection | 0% | HIGH | No detection mechanism | Task 4 |
| Lifecycle hooks | 0% | HIGH | No structured gate framework | Task 10, 11, 12 |
| Human-in-the-loop (UI) | 55% | HIGH | No review UI, no direct routing | Task 8, 13 |
| Tick persistence | 30% | HIGH | No persistent scheduling | Task 5 |
| UI task management | 50% | HIGH | Missing detail view, review UI | Task 7, 8 |
| Persistence/recovery | 70% | MEDIUM | Pending runs, no mirroring | Task 2 |
| Event handling | 65% | MEDIUM | No real-time task DaemonHub events | Task 9 |
| Inter-agent messaging | 95% | LOW | Minor: no answerQuestion | -- |
| Worktree isolation | N/A | DESIGN | Intentional design difference | -- |

**Methodology:** Parity percentages are qualitative assessments. "15%" means only metadata fields exist with no runtime integration; "50%" means types are present but no runtime logic; "95%" means near-complete with minor gaps.

---

## Room System Components (Reference)

| Component | File | Description |
|-----------|------|-------------|
| `RoomRuntime` | `room/runtime/room-runtime.ts` | Central orchestrator per room. Detects goals, spawns session groups, routes output, enforces review limits, handles lifecycle hooks. |
| `RoomRuntimeService` | `room/runtime/room-runtime-service.ts` | Wires RoomRuntime instances into the daemon. One runtime per room. |
| `TaskGroupManager` | `room/runtime/task-group-manager.ts` | Manages (Worker, Leader) session group lifecycle. |
| `SessionObserver` | `room/state/session-observer.ts` | Subscribes to `session.updated` DaemonHub events. |
| `GoalManager` | `room/managers/goal-manager.ts` | Full mission system: CRUD, metrics, executions, cron, progress. |
| `LifecycleHooks` | `room/runtime/lifecycle-hooks.ts` | Deterministic runtime gates with bypass markers. |
| `ErrorClassifier` | `room/runtime/error-classifier.ts` | 4-class error taxonomy. |
| `DeadLoopDetector` | `room/runtime/dead-loop-detector.ts` | Count-based and similarity-based bounce detection. |
| `HumanMessageRouting` | `room/runtime/human-message-routing.ts` | Routes human messages to worker or leader. |
| `RuntimeRecovery` | `room/runtime/runtime-recovery.ts` | Restores active groups after daemon restart. |
| `RateLimitUtils` | `room/runtime/rate-limit-utils.ts` | Parses rate limit reset times, creates backoff strategies. |
| `CronUtils` | `room/runtime/cron-utils.ts` | Cron expression parsing, next-run computation, catch-up detection. |

---

## Space-Exclusive Advantages (Room Does NOT Have)

These are capabilities that Space has which Room lacks entirely. They represent the fundamental value proposition of the Space system.

| Feature | Space | Room |
|---------|-------|------|
| Visual workflow editor | Full drag-drop canvas with pan/zoom, node cards, edge editing | None |
| Multi-agent parallel steps | Multiple agents per workflow step, all concurrent | Single worker per task |
| Channel topology | Flexible directed/bidirectional edges via ChannelResolver | Fixed Worker-to-Leader routing |
| Condition-based transitions | always, human, condition (shell), task_result | Implicit via Leader tool calls |
| Task Agent architecture | MCP-tool-driven orchestration (agent drives workflow) | Direct advance() calls (runtime drives) |
| NotificationSink pattern | Structured event interface with testable NullNotificationSink | Ad-hoc daemonHub.emit() calls |
| Per-agent overrides | Model and system prompt per agent slot | Agent model override only |
| Workflow templates | Coding, Research, Review-Only built-in workflows | No workflow templates |
| Export/Import | Full agent + workflow export/import system | No export/import |
| Custom agents | User-defined agents with roles, prompts, models | Preset roles only |
