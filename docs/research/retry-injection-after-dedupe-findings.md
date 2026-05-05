# Research Findings: Retry Delivery When Injection Fails After Dedupe Marking

## Issue Summary
**P1 Review Comment** on PR #1777 (Design: external event bus for Space workflow nodes):
> Marking the event as delivered before attempting `injectMessage` creates permanent loss on transient delivery failures. The design justifies this by saying a restart poll will emit a fresh event, but in the current pipeline `SpaceGitHubService.ingest` short-circuits duplicates from `storeEvent` and does not re-route the same `dedupeKey`, so a failed injection will not be retried for that subscription.

## Investigation

### Affected Components
1. **Design Document**: `docs/plans/design-external-event-bus-for-space-workflow-nodes.md` (PR #1777)
   - Section 4: `deliverToSubscription` method marks dedup BEFORE injection
   - Incorrect assumption: "upstream SpaceGitHubService re-polls on restart and will generate a fresh event"
2. **Implementation Code**: `packages/daemon/src/lib/github/space-github.ts`
   - `SpaceGitHubService.ingest()` short-circuits ALL duplicates (line 602)
   - `flushTaskNotification()` marks state as 'delivered' only on success, but duplicate events never reach injection

## Code Analysis

### Dedupe Flow in `SpaceGitHubService`
1. `ingest()` calls `storeEvent()` which uses `INSERT OR IGNORE` on `dedupe_key` (line 338)
2. If duplicate: `ingest()` returns immediately (line 602: `if (stored.duplicate) return stored.event`)
3. This means even if the original event's injection failed, subsequent events with the same `dedupeKey` are ignored entirely

### Injection Failure Scenario
1. Event arrives via webhook → `ingest()` → `storeEvent()` (new, state: 'received')
2. Resolved to task → state updated to 'routed'
3. `flushTaskNotification()` attempts `injectTaskAgent()` → fails (transient error)
4. State remains 'routed' (not updated to 'delivered' or 'failed')
5. Later, same event is polled from GitHub → `ingest()` → `storeEvent()` returns duplicate
6. `ingest()` returns immediately → NO retry of injection → **permanent event loss**

### Design Document Flaw
The design document's `deliverToSubscription` method contains the same flawed logic:
```typescript
// Mark dedup BEFORE session resolution / queueing...
this.delivered.set(dedupeKey, Date.now());

// Later, on injection failure:
catch (err) {
  log.warn(`Failed to deliver event to ${sub.agentName}`, { error: err });
  // Event is already dedup-marked so it won't be re-delivered for this run.
  // A fresh event will arrive via the next poll cycle if the underlying external event is still relevant.
}
```

This is incorrect because:
- The "fresh event" from polling will have the same `dedupeKey`
- `SpaceGitHubService.ingest()` will short-circuit it before it reaches the event bus
- The event never gets re-delivered to the node

## Root Cause
1. **Premature dedup marking**: Both `SpaceGitHubService` and the design document mark events as "processed" before confirming successful delivery
2. **Unconditional duplicate short-circuit**: `ingest()` doesn't distinguish between terminal states (delivered, ignored) and retry-able states (routed, failed)
3. **No retry mechanism**: Failed injections are logged but never retried

## Recommended Fixes

### Fix 1: Update `SpaceGitHubService` (Implementation)
1. **Modify `ingest()` to not short-circuit retry-able duplicates**:
   ```typescript
   async ingest(spaceId: string, event: NormalizedSpaceGitHubEvent): Promise<StoredSpaceGitHubEvent> {
     const stored = this.repo.storeEvent({ spaceId, event });
     if (stored.duplicate) {
       // Only short-circuit if in terminal state
       const existing = stored.event;
       if (['delivered', 'ignored', 'ambiguous'].includes(existing.state)) {
         return existing;
       }
       // For non-terminal states (routed, failed), re-process
       // (injection will be retried via scheduleTaskNotification)
     }
     // ... rest of processing
   }
   ```

2. **Add retry logic to `flushTaskNotification()`**:
   - Track retry count in event state or separate map
   - Retry with exponential backoff (max 3 retries)
   - On max retries, update state to 'failed' (terminal)

### Fix 2: Update Design Document (PR #1777)
1. **Change dedup marking order**: Mark dedup AFTER successful injection, not before
2. **Add pending state tracking**: Track "pending" deliveries to prevent duplicate queueing without preventing retries
3. **Remove incorrect assumption**: Re-polling doesn't help because of `ingest()` short-circuit
4. **Add retry mechanism**: For the event bus, retry failed deliveries with backoff

### Proposed Design Document Changes
In `deliverToSubscription()`:
```typescript
private async deliverToSubscription(event: ExternalEvent, sub: Subscription): Promise<void> {
  // ... scope check ...

  // Dedup check — use a "pending" set to prevent duplicate queueing, but allow retries
  this.evictStaleDedup();
  const dedupeKey = `${event.dedupeKey}:${sub.taskId}:${sub.nodeId}:${sub.agentName}:${sub.workflowRunId}`;

  // Check if already delivered (terminal)
  if (this.delivered.has(dedupeKey)) {
    return;
  }

  // Check if pending (prevents duplicate queueing)
  if (this.pendingDeliveries.has(dedupeKey)) {
    return;
  }

  // Mark as pending (prevents duplicate queueing, but not retriable)
  this.pendingDeliveries.add(dedupeKey);

  try {
    // Resolve session
    const sessionId = await this.resolveSession(sub);
    if (!sessionId) {
      this.queueForDelivery(event, sub);
      return; // Pending remains until queue is drained
    }

    // Inject
    const message = this.formatEventMessage(event);
    await this.sessionFactory.injectMessage(sessionId, message, { deliveryMode: 'defer' });

    // Success: mark as delivered, remove pending
    this.delivered.set(dedupeKey, Date.now());
    this.pendingDeliveries.delete(dedupeKey);
  } catch (err) {
    // Failure: remove pending so it can be retried
    this.pendingDeliveries.delete(dedupeKey);
    log.warn(`Failed to deliver event to ${sub.agentName}`, { error: err });

    // Optional: retry with backoff
    this.scheduleRetry(event, sub, dedupeKey);
  }
}
```

## Conclusion
The review comment is **valid**. The current design and implementation permanently lose events when transient injection failures occur. The fix requires:
1. Not marking events as "processed" before confirming successful delivery
2. Allowing retries for failed injections
3. Updating `ingest()` to not short-circuit duplicates in non-terminal states

## Next Steps
1. Update design document in PR #1777 to reflect correct dedup logic
2. Fix `SpaceGitHubService.ingest()` and `flushTaskNotification()` in code
3. Add tests for injection retry scenarios
4. Update documentation to reflect new delivery guarantees
