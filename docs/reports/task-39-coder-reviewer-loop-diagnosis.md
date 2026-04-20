# Task #39 — Coder ↔ Reviewer loop prematurely marks workflow run `done`

## Summary

In the default Coding Workflow, any `send_message` from the Coder back to the
Reviewer after round 1 failed with:

```
Cannot activate node for run in status 'done'
```

The workflow run was transitioning to the terminal `done` state on **round 1
"request changes"** — i.e. before the loop had converged on an approval — which
locked out further activity.

## Hypotheses considered

The task brief listed three hypotheses. Only one was correct.

1. **Premature `report_result()` by the Reviewer in the "request changes"
   branch.** ✅ **Correct root cause.**
2. CompletionDetector treats any non-null `reportedStatus` as terminal. ✅
   Contributing cause — it's the mechanism by which `report_result()` flips the
   run to `done`.
3. "Run → done" path missing an approval gate. ✅ Contributing — even if the
   Reviewer's prompt had been well-behaved, there was nothing structural in
   the workflow stopping the Reviewer from marking the run done on any round.

Hypotheses 1 and 3 are two layers of the same defect. The fix addresses both.

## Root cause (mechanism)

Three code paths combined:

1. **Built-in Coding Workflow shape.** The template had only two nodes —
   `Coding` and `Review` — and declared `endNodeId = Review`.
   (`packages/daemon/src/lib/space/workflows/built-in-workflows.ts`).
2. **`report_result` tool registration.** The tool is registered only for
   agents whose `workflowNodeId === workflow.endNodeId`
   (`packages/daemon/src/lib/space/runtime/task-agent-manager.ts:2446`). In the
   old shape that was the Reviewer.
3. **Reviewer prompt.** The seeded Reviewer `customPrompt` instructed the
   agent to call `report_result(status="done", ...)` on approval **and**
   `report_result(status="failed", ...)` on "request changes". Combined with
   (2), every "request changes" round in round 1 caused the Reviewer to call
   `report_result`, which set `task.reportedStatus`.

On each agent return, `CompletionDetector.isComplete(...)` was called. It
treats `task.reportedStatus !== null` as a terminal signal
(`packages/daemon/src/lib/space/runtime/completion-detector.ts`), so the run
flipped to `done`. The Coder's next `send_message` back to the Reviewer then
hit the guard in `SpaceRuntime.activateNode` and failed.

## Fix

Two layers of defense:

### Layer 1 — Workflow shape: add a dedicated Done closer node

Restructure `CODING_WORKFLOW` to a three-node graph:

```
Coding ⇄ Review → Done
```

- `Coding ↔ Review` stays an iterative loop (unchanged semantics).
- `Review → Done` is a one-way edge **gated on approval**.
- `Done` is the new `endNodeId`. Its agent is the preset `General` role,
  prompted to call `report_result("done", ...)` once activated — nothing else.

Because `report_result` is registered only for the end-node agent, the
Reviewer no longer has that tool at all. The Reviewer's updated prompt sends
`send_message(target="Done", data={ approved: true })` on approval and
`send_message(target="Coding", ...)` on "request changes". Neither call can
terminate the run.

### Layer 2 — Approval gate on the Review → Done channel

A new gate, `review-approval-gate`, is attached to the `Review → Done`
channel:

```ts
{
  id: 'review-approval-gate',
  fields: [{
    name: 'approved',
    type: 'boolean',
    writers: ['reviewer'],          // only reviewer can write
    check: { op: '==', value: true }, // gate opens only on true
  }],
  resetOnCycle: false,
}
```

`writers: ['reviewer']` lets the Reviewer write the gate field directly via
`send_message`'s `data` payload, regardless of autonomy level (the writers
path bypasses the autonomy check). Human approval via `spaceWorkflowRun.
approveGate` is unaffected.

The channel router (`packages/daemon/src/lib/space/runtime/channel-router.ts`)
only activates the target of a gated channel when the gate opens, so `Done`
cannot be reached without `approved: true`.

### Knock-on: migration 94

Migration 94 carries an inlined fingerprint of each built-in template and
backfills `template_name` + `template_hash` on pre-M90 rows that still need
tracking metadata. The `hash self-verification` test
(`packages/daemon/tests/unit/4-space-storage/storage/migrations/migration-94_test.ts`)
enforces that the inlined fingerprint matches `computeWorkflowHash(currentTemplate)`.
Updating the Coding Workflow template required updating M94's inlined copy in
lockstep, which is what the test was designed to catch.

The `endNodeCompletionActions` entry (`MERGE_PR_COMPLETION_ACTION`) moved
from the `Review` node to the `Done` node in both the live template and M94.

## Verification

### New regression tests

`packages/daemon/tests/unit/5-space/workflow/coding-workflow-approval-gate.test.ts`
— 7 tests, all backed by the real `ChannelRouter` + `CompletionDetector`
against the seeded template:

- `seeded Done node is the workflow endNodeId (not Review)`
- `the only channel into the Done node is gated by review-approval-gate`
- `Reviewer requesting changes does NOT activate Done and does NOT mark the
  run complete`
- `review-approval-gate stays closed until approved: true is written`
- `writing approved: true via the gate activates Done; only then does
  CompletionDetector flip`
- `full round-trip: request-changes keeps loop alive, approval ultimately
  completes the run`
- `review-approval-gate.approved is declared writable only by the reviewer`

### Existing tests updated

- `built-in-workflows.test.ts` — the "CODING_WORKFLOW template" and seeded
  describe blocks now assert the 3-node / 3-channel / 2-gate shape, Done's
  General agent assignment, the completion action's move to Done, and the
  updated Reviewer / Done customPrompts.
- `completion-actions-persistence.test.ts` — the defensive Bug-B regression
  tests now target the `Done` node as the completion-action carrier.
- `migration-94_test.ts` — `seedLegacyCodingWorkflow` now seeds the 3-node
  shape; `hash self-verification` still exercises all five templates and
  passes; `divergent row` test seeds a 3-node row.

### Test results

```
./scripts/test-daemon.sh   → 11103 pass / 0 fail (modulo one settings-manager
                              flake that passes standalone)
```

## Acceptance criteria — mapping

| Criterion | Where |
|-----------|-------|
| Run only transitions to `done` when the Done node is activated AND its inbound channel gate is approved | `coding-workflow-approval-gate.test.ts`: "writing approved: true via the gate activates Done; only then does CompletionDetector flip" |
| Cyclic loop stays `in_progress` on "request changes" | `coding-workflow-approval-gate.test.ts`: "Reviewer requesting changes does NOT activate Done and does NOT mark the run complete" |
| Unit test for the full round-trip | `coding-workflow-approval-gate.test.ts`: "full round-trip: request-changes keeps loop alive, approval ultimately completes the run" |
| Unit test: run.status → `done` only when Done's inbound gate is approved | `coding-workflow-approval-gate.test.ts`: "review-approval-gate stays closed until approved: true is written" |
| Default Coding Workflow (`303ceda3-d100-44a9-952e-161a0fa28b0c`) gets an explicit approval gate on the channel into Done | `built-in-workflows.ts` — new `review-approval-gate` + `Review → Done` channel |

## Out of scope

- Other built-in workflows (`Research`, `Review-Only`, `Full-Cycle`, `Coding
  with QA`) — not touched; their existing gating is unchanged.
- SpaceRuntime's generic transition logic — untouched; the fix is template-
  shape + gate, not runtime.
- A retro-migration that converts existing 2-node user Coding Workflow rows
  to the new 3-node shape — intentionally deferred. Existing rows continue to
  function with their legacy shape; drift is detectable via template_hash.
