# Milestone 2: TaskAgentManager Group Persistence

## Goal

Wire `TaskAgentManager` to persist session groups in the database instead of managing sessions purely in-memory. Emit events via DaemonHub so the frontend (and other consumers) can react to group changes in real time.

## Scope

- Inject `SpaceSessionGroupRepository` into `TaskAgentManager`
- Create groups on `spawnTaskAgent()`, add members on sub-session creation
- Update member status on completion/failure
- Emit `space.sessionGroup.*` events via DaemonHub
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
1. Define event types: `space.sessionGroup.created`, `space.sessionGroup.memberAdded`, `space.sessionGroup.memberUpdated`
2. In `spawnTaskAgent()`, after creating the group, emit `space.sessionGroup.created` with `{ spaceId, taskId, group: SpaceSessionGroup }`
3. In the sub-session factory, after adding a member, emit `space.sessionGroup.memberAdded` with `{ spaceId, groupId, member: SpaceSessionGroupMember }`
4. In completion/failure handlers, after updating member status, emit `space.sessionGroup.memberUpdated` with `{ spaceId, groupId, memberId, member: SpaceSessionGroupMember }`
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
3. Test that `spawnTaskAgent()` creates a group and emits `space.sessionGroup.created`
4. Test that sub-session creation adds a member and emits `space.sessionGroup.memberAdded`
5. Test that sub-session completion updates member status and emits `space.sessionGroup.memberUpdated`
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
