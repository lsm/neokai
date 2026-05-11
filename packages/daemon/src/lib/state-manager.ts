/**
 * StateManager — compatibility re-export
 *
 * M5 renamed `StateManager` to `StateProjectionService` to reflect its
 * single responsibility: maintaining read-model caches from internal events.
 * Client delivery, side effects, and event forwarding now live in separate
 * subscribers (ClientEventBridge, InternalEventBus handlers).
 *
 * This file re-exports the new name so downstream imports don't break
 * during the migration window. New code should import from
 * `state-projection-service.ts` directly.
 *
 * TODO(M8): Remove this re-export once all call sites have migrated.
 */

export { StateProjectionService as StateManager } from './state-projection-service';
