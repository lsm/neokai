Run the Playwright end-to-end test suite for NeoKai.

Execute the following steps:

1. Check whether a dev server is already running by looking for `tmp/.dev-server-running`. If the lock file exists, use that port with `make self-test`; otherwise use `make run-e2e` which starts its own server.

2. If a specific test file was mentioned by the user, run only that file:
   ```
   make run-e2e TEST=tests/features/<test-file>.e2e.ts
   ```
   Otherwise run all E2E tests:
   ```
   make run-e2e
   ```

3. Report the results:
   - List any failing tests with their error messages
   - Summarise the total pass/fail counts
   - If tests fail, suggest likely causes based on the error output

Important notes:
- Always run a single E2E test file at a time when targeting a specific scenario — running all tests together is slow
- E2E tests are located in `packages/e2e/tests/`
- The test command builds the web bundle, starts a server on a random port, runs tests, then shuts down
