# Milestone 2: TaskAgentManager Group Persistence

## Goal

Wire `TaskAgentManager` to persist session groups in the database instead of managing sessions purely in-memory. Emit events via DaemonHub so the frontend (and other consumers) can react to group changes in real time.

## Scope

- Inject `SpaceSessionGroupRepository` into `TaskAgentManager`
- Create groups on `spawnTaskAgent()`, add members on sub-session creation
- Update member status on completion/failure
- Emit `spaceSessionGroup.*` events via DaemonHub
- Rehydrate `taskId -> groupId` map on daemon restart
- Unit tests for group persistence and event emission

---

### Task 2.1: Wire SpaceSessionGroupRepository into TaskAgentManager

**Description:** Add `SpaceSessionGroupRepository` as a dependency of `TaskAgentManager` and create a session group when spawning a Task Agent.

**Subtasks:**
1. Add `sessionGroupRepo: SpaceSessionGroupRepository` to `TaskAgentManagerConfig`
2. In `spawnTaskAgent()`, after creating the AgentSession, call `sessionGroupRepo.createGroup()` with `spaceId`, a name like `task:${taskId}`, and `taskId`
3. Add the Task Agent session as the first group member with role matching the task's agent role (or `'task-agent'` for the coordinator) and `status: 'active'`
4. Store the `groupId` in an in-memory map (`taskId -> groupId`) for fast lookup when adding sub-session members
5. Update `TaskAgentManagerConfig` interface and construction site in `space-runtime-service.ts` (or wherever TaskAgentManager is instantiated) to pass the repository
6. **Wire `SpaceSessionGroupRepository` into the DaemonApp construction graph**: The repository needs the `db` handle. Trace the injection through `DaemonApp` → `SpaceRuntimeService` → `TaskAgentManager` and ensure `SpaceSessionGroupRepository` is constructed once and injected (not double-instantiated). Add it as a parameter alongside existing repositories.

**Acceptance Criteria:**
- After `spawnTaskAgent()`, a `SpaceSessionGroup` record exists in DB with the Task Agent as a member
- The group has `taskId` set correctly
- No regression in existing task agent spawning behavior

**Dependencies:** Task 1.3 (updated repository)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.2: Add Sub-Session Members to Groups

**Description:** When `TaskAgentManager` creates sub-sessions (step agents), add them as members of the existing group for that task.

**Subtasks:**
1. In `createSubSessionFactory()` (the factory returned by `this.createSubSessionFactory(taskId)`), after creating the sub-session, look up the `groupId` for the `taskId`
2. Call `sessionGroupRepo.addMember()` with the sub-session's `sessionId`, the agent's role from SpaceAgent, the `agentId`, and `status: 'active'`
3. Track `orderIndex` incrementally per group (use member count as index)
4. In the sub-session completion handler (`handleSubSessionComplete`), call `sessionGroupRepo.updateMemberStatus()` to set the member to `'completed'`
5. In error/failure paths, update member status to `'failed'`

**Acceptance Criteria:**
- Sub-sessions appear as group members in DB with correct `agentId`, `role`, and `status`
- Member status transitions to `'completed'` or `'failed'` appropriately
- Multiple sub-sessions for the same task all appear in the same group

**Dependencies:** Task 2.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Emit Session Group Events via DaemonHub

**Description:** Emit structured events when session groups are created, members are added, and member status changes. These events will drive frontend reactivity.

**Subtasks:**
1. Define event types: `spaceSessionGroup.created`, `spaceSessionGroup.memberAdded`, `spaceSessionGroup.memberUpdated`
2. In `spawnTaskAgent()`, after creating the group, emit `spaceSessionGroup.created` with `{ spaceId, taskId, group: SpaceSessionGroup }`
3. In the sub-session factory, after adding a member, emit `spaceSessionGroup.memberAdded` with `{ spaceId, groupId, member: SpaceSessionGroupMember }`
4. In completion/failure handlers, after updating member status, emit `spaceSessionGroup.memberUpdated` with `{ spaceId, groupId, memberId, member: SpaceSessionGroupMember }`
5. Emit events on the space-specific channel (`space:${spaceId}`) so only clients subscribed to that space receive them

**Acceptance Criteria:**
- Events are emitted at the correct lifecycle points
- Event payloads contain complete data (full group or member objects, not just IDs)
- Events use the space channel for scoping

**Dependencies:** Task 2.2

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.4: Unit Tests for Group Persistence and Events

**Description:** Write unit tests verifying that TaskAgentManager correctly creates groups, adds members, updates statuses, and emits events.

**Subtasks:**
1. Create test file `packages/daemon/tests/unit/task-agent-manager-groups.test.ts`
2. Mock `SpaceSessionGroupRepository` and `DaemonHub` to verify calls
3. Test that `spawnTaskAgent()` creates a group and emits `spaceSessionGroup.created`
4. Test that sub-session creation adds a member and emits `spaceSessionGroup.memberAdded`
5. Test that sub-session completion updates member status and emits `spaceSessionGroup.memberUpdated`
6. Test that sub-session failure sets member status to `'failed'`
7. Test idempotency: spawning the same task agent twice does not create duplicate groups
8. Test cleanup: verify group state is consistent after task agent cleanup

**Acceptance Criteria:**
- All tests pass with `cd packages/daemon && bun test tests/unit/task-agent-manager-groups.test.ts`
- Tests cover the full lifecycle: create -> add members -> complete/fail
- Event emission is verified with correct payloads

**Dependencies:** Task 2.3

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.5: Rehydrate Group Map on Daemon Restart

**Description:** The in-memory `taskId -> groupId` map stored in `TaskAgentManager` is lost on daemon restart. The existing `rehydrateTaskAgent()` path does NOT rebuild this map. This task ensures the map is rebuilt from DB on startup so that event emission and Phase 3 group-scoped security checks work correctly after restarts.

**Subtasks:**
1. Add a `rehydrateGroupMaps()` method to `TaskAgentManager` that queries `SpaceSessionGroupRepository` for all active groups (where group status is `'active'`) and rebuilds the `taskId -> groupId` in-memory map
2. Call `rehydrateGroupMaps()` from the existing `rehydrateTaskAgent()` path (or from wherever TaskAgentManager is initialized on startup)
3. Ensure the rehydration handles edge cases: groups without a `taskId` (standalone groups), groups with no active members
4. Add a unit test that verifies the map is correctly rebuilt after simulated restart

**Acceptance Criteria:**
- After daemon restart, `taskId -> groupId` lookups return correct values for all active groups
- Event emission (Task 2.3) continues to work correctly after restart
- Phase 3 group-scoped security checks (Task 6.1) will have valid group lookups after restart
- No performance regression on startup (query is indexed on `task_id`)

**Dependencies:** Task 2.1

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
