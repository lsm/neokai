# Milestone 6: Test Coverage and E2E

## Goal

Add comprehensive test coverage for the new behavior: required `defaultPath` validation, fallback removal, `room.update` propagation, and an E2E test for the updated room creation flow.

## Scope

- `packages/daemon/tests/` -- additional unit and online tests
- `packages/e2e/tests/` -- E2E test for room creation with workspace path
- Integration verification across all milestones

---

### Task 6.1: Integration tests for room workspace isolation

**Description**: Write online/integration tests that exercise the full room lifecycle with explicit workspace paths, verifying that workspace resolution never falls back to the daemon's `workspaceRoot`. Test room creation, session creation within the room, reference resolution, and `room.update` with path change.

**Subtasks**:
1. Create `packages/daemon/tests/online/room/room-workspace-isolation.test.ts`.
2. Test: create a room with `defaultPath` pointing to a temp directory. Verify the room chat session's `workspacePath` matches `defaultPath`, not the daemon's `workspaceRoot`.
3. Test: send a reference resolution request (`@file` or `@folder`) in the room chat session. Verify it searches within the room's `defaultPath`, not the daemon's workspace. **Important**: Create temp directories with known fixture files (e.g., `test-file.txt` in the room's temp dir, a different file in the daemon's workspace dir) so the test can assert which directory was searched. Clean up temp dirs in `afterEach`.
4. Test: update `defaultPath` to a new temp directory (with no active tasks). Verify the room chat session's `workspacePath` is updated.
5. Test: attempt to update `defaultPath` while a task is active. Verify it is rejected with the expected error.
6. Run with `NEOKAI_USE_DEV_PROXY=1 bun test` to verify.

**Acceptance Criteria**:
- Integration tests verify workspace isolation end-to-end.
- Tests pass with dev proxy (no real API calls).
- Reference resolution respects room `defaultPath`.

**Dependencies**: Tasks 4.2, 3.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 6.2: E2E test for room creation with workspace path

**Description**: Write a Playwright E2E test that verifies the updated `CreateRoomModal` flow: opening the modal, filling in a room name and workspace path, creating the room, and verifying the room is created with the correct `defaultPath`.

**Subtasks**:
1. Create `packages/e2e/tests/features/room-creation-workspace.e2e.ts`.
2. Test flow: navigate to lobby, click "Create Room", verify the workspace path field is visible and pre-populated (or empty if no daemon workspace), fill in room name and workspace path, submit, verify room appears in the lobby.
3. Verify the created room's workspace path is displayed correctly in the room overview/settings (if visible in the UI).
4. Test validation: try to submit without workspace path, verify error is shown.
5. Use `beforeEach`/`afterEach` for room cleanup via RPC (allowed per E2E conventions).
6. Run with `make run-e2e TEST=tests/features/room-creation-workspace.e2e.ts`.

**Acceptance Criteria**:
- E2E test passes against a running server.
- Room creation requires workspace path in the UI.
- Validation errors are shown for missing path.
- Created room has the correct `defaultPath`.

**Dependencies**: Tasks 2.2, 5.2

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
