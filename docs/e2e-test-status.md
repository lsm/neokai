# E2E Test Status — 2026-04-04

CI Run: 23971370596 (fix(e2e): stabilize neo-panel tests)
Result: 27 failures / 55 passes

## Root Causes Identified

### A: SpaceDashboard hidden by WorkflowCanvas (md+)
Built-in workflows seeded on space creation → showCanvas=true → SpaceDashboard md:hidden.
Affects: space-navigation, space-task-fullwidth, space-task-creation, space-creation, space-happy-path-pipeline

### B: Sandbox ripgrep missing in CI
SDK expects /tmp/neokai-sdk/vendor/ripgrep/x64-linux/rg, CI only installs bubblewrap+socat.
Affects: core-connection-resilience, features-provider-model-switching, features-neo-conversation, all LLM tests

### C: neo-conversation needs same fixes as neo-panel (#1297)
Affects: features-neo-conversation (close/Escape/backdrop/tab tests)

### D: neo-panel role=dialog causes strict mode violations
Affects: features-space-creation, features-space-task-fullwidth, features-space-task-creation

### E: Individual test bugs
- features-space-settings-crud: locator('text='+path) creates invalid regex for paths with slashes
- settings-tools-modal: button[aria-label] should be button[title] for Session options
- features-space-agent-chat: textarea selector matches neo-panel after navigation
- features-space-agent-centric-workflow: selectOption timeout
- features-space-context-panel-switching: space click navigation timeout
- features-space-approval-gate-rejection + features-reviewer-feedback-loop: gate UI changes
- features-space-multi-agent-editor + features-visual-workflow-editor: UI changes
- settings-mcp-servers: isChecked timeout
