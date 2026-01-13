/**
 * Setup Happy-DOM for hook tests
 *
 * Hook tests use renderHook from @testing-library/preact which requires
 * a proper DOM environment to work correctly. Without this setup, tests
 * may fail with "TypeError: undefined is not an object (evaluating 't.__k')"
 * errors due to Preact's internal state not being initialized.
 */

import '../../lib/__tests__/setup';
