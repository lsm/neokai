Run NeoKai's Playwright end-to-end tests in interactive/UI mode so you can watch and debug tests step by step.

Execute the following steps:

1. Ensure the dev server is running. Start it if needed:
   ```
   make self WORKSPACE=<workspace-path>
   ```
   The server writes its port to `tmp/.dev-server-running`.

2. Run the target test in headed mode against the already-running server:
   ```
   make self-test TEST=tests/features/<test-file>.e2e.ts
   ```
   If no specific test is given, ask the user which test scenario they want to debug before proceeding.

3. After each test run, report:
   - What happened in each test step
   - Any assertion failures with the expected vs actual values
   - Screenshots or traces if available in `test-results/`

4. Offer to re-run the test, adjust selectors, or add additional assertions based on what was observed.

Important notes:
- Use `make self-test` (not `make run-e2e`) so tests run against the already-started dev server
- The `make self` server runs on port 9983 by default
- Playwright trace files are saved to `test-results/` and can be opened with `bunx playwright show-trace`
- E2E tests are located in `packages/e2e/tests/`
