# Comprehensive Space Feature End-to-End Review

## Goal

Full review and hardening of the Space feature happy path. Ensure all 12 core workflows work end-to-end with good test coverage (unit + e2e). Identify gaps, fix them, and add test coverage.

## Approach

The plan is organized into 7 milestones, progressing from foundational backend correctness through UI hardening to comprehensive E2E test coverage. Each milestone targets a coherent set of happy paths and can be worked on sequentially. Bug fixes and missing features are addressed before test coverage is added.

## Milestones

1. **Space Creation and Seeding Hardening** -- Verify space creation, agent/workflow seeding, error recovery. Add unit tests for partial seed failure. (Happy paths 1, 2)
2. **Task Lifecycle and Status Management** -- Harden task creation from agent conversation, manual status control UI (blocked->in_progress), blocked reason visibility. (Happy paths 3, 4, 10, 12)
3. **Runtime Tick and Workflow Execution** -- Verify task execution via runtime ticks, workflow executor correctness, crash recovery. Add missing unit tests for edge cases. (Happy path 5)
4. **Task View and Agent Messages** -- Harden unified thread rendering, agent color differentiation, agent overlay chat (currently full-page navigation). (Happy paths 6, 7)
5. **Canvas Mode and Artifacts Panel** -- Add canvas mode toggle from task view, verify workflow visualization, add artifacts side panel integration. (Happy paths 8, 9)
6. **User Interaction in Task View** -- Verify user messaging to task agent, @mention routing to specific agents. Add unit tests for channel routing. (Happy path 11)
7. **E2E Test Coverage Expansion** -- Add Playwright E2E tests covering gaps: blocked task display, manual status control, canvas mode, artifacts panel, agent overlay, runtime tick progression. (All happy paths)

## Cross-Milestone Dependencies

- Milestone 2 depends on milestone 1 (space must be created correctly before tasks work)
- Milestone 3 depends on milestone 2 (tasks must exist before runtime can execute them)
- Milestone 4 depends on milestone 3 (agent messages appear during/after execution)
- Milestone 5 depends on milestone 3 (canvas shows runtime state)
- Milestone 6 depends on milestone 4 (user interaction builds on message thread)
- Milestone 7 depends on all prior milestones (E2E tests validate the fixed behavior)

## Total Estimated Task Count

27 tasks across 7 milestones.

## Key Files

### Backend
- `packages/daemon/src/lib/space/managers/` -- All space managers
- `packages/daemon/src/lib/space/runtime/` -- Runtime engine
- `packages/daemon/src/lib/space/agents/seed-agents.ts` -- Agent seeding
- `packages/daemon/src/lib/space/workflows/built-in-workflows.ts` -- Workflow templates
- `packages/daemon/src/lib/rpc-handlers/space-*.ts` -- RPC handlers

### Frontend
- `packages/web/src/islands/SpaceIsland.tsx` -- Main space content
- `packages/web/src/components/space/SpaceTaskPane.tsx` -- Task detail view
- `packages/web/src/components/space/SpaceDashboard.tsx` -- Overview dashboard
- `packages/web/src/components/space/WorkflowCanvas.tsx` -- Canvas visualization
- `packages/web/src/components/space/GateArtifactsView.tsx` -- Artifacts/diff view

### Tests
- `packages/daemon/tests/unit/space/` -- 53 unit test files
- `packages/daemon/tests/online/space/` -- Online integration tests
- `packages/e2e/tests/features/space-*.e2e.ts` -- 16 E2E test files
