# npm global install SDK binary investigation

Date: 2026-05-15
Task: #390 — Investigate npm global install SDK binary issue

## Executive summary

`npm install -g neokai@0.24.0` works in a clean Linux x64 Docker container and on a clean macOS x64 npm prefix for startup-level validation:

- Linux container: `node:22-bookworm`, npm `10.9.8`, Node `v22.22.3`.
- `kai --version` prints `0.24.0`.
- `kai --db-path /tmp/test-neokai-global` starts the server process and stays running past 10 seconds in the container.
- No `cli.js` import error occurs during startup.

The clean container install confirms npm installs the Linux platform package (`@neokai/cli-linux-x64@0.24.0`) and the compiled Linux binary starts successfully. The installed `neokai` package does not include SDK npm packages as runtime `node_modules`; SDK native CLI resolution is handled by the bundled resolver at first SDK use.

SDK 0.2.141 does not ship `cli.js`. It ships SDK JS entrypoints plus platform-native optional dependencies named `@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]`, each containing a native `claude`/`claude.exe` binary. The current source tree already has the correct post-0.2.141 approach: `packages/cli/prod-entry.ts` no longer embeds `cli.js`; `packages/daemon/src/lib/agent/sdk-cli-resolver.ts` resolves the platform package, cache, or downloads the binary from npm.

Recommendation: keep current `prod-entry.ts` architecture. Add release-time smoke coverage for the installed npm package on Linux in CI, because local Docker was unavailable and startup-only validation does not exercise SDK query execution.

## Environment and constraints

- Worktree: `/Users/lsm/.neokai/projects/dev-neokai-ec0a1deb/worktrees/investigate-npm-global-install-sdk-binary-issue`
- Host platform observed from npm behavior: `darwin-x64`
- npm package under test: published `neokai@0.24.0`, not local build
- SDK package inspected: `@anthropic-ai/claude-agent-sdk@0.2.141`

Docker initially failed because the OrbStack socket was unavailable:

```text
failed to connect to the docker API at unix:///Users/lsm/.orbstack/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/lsm/.orbstack/run/docker.sock: connect: no such file or directory
```

Running `orb start` restored Docker access:

```text
OrbStack is already running. Docker engine is ready to use.
```

Docker server used for container test:

```text
Server: Docker Engine - Community
 Version: 28.5.2
 OS/Arch: linux/amd64
```

## Tests performed

### 1. Clean Docker Linux x64 install

Command shape:

```bash
docker run --rm node:22-bookworm bash -lc '
  set -euxo pipefail
  npm --version
  node --version
  npm install -g neokai@0.24.0
  which kai
  kai --version
  kai --db-path /tmp/test-neokai-global > /tmp/kai-start.log 2>&1 &
  pid=$!
  sleep 10
  if kill -0 "$pid" 2>/dev/null; then
    echo "kai_start_status=still_running"
    kill "$pid"
    wait "$pid" 2>/dev/null || true
  else
    wait "$pid"
    echo "kai_start_exit=$?"
  fi
  cat /tmp/kai-start.log
'
```

Observed install/runtime output:

```text
npm --version -> 10.9.8
node --version -> v22.22.3
added 2 packages in 4s
/usr/local/bin/kai
0.24.0
kai_start_status=still_running
```

Startup log:

```text
NeoKai Server
   Database: /tmp/test-neokai-global

[kai:cli:prod-server] Starting production server...
[kai:cli:prod-server] Extracted 15 built-in skill files to /root/.neokai/skills
[Daemon] NO CREDENTIALS DETECTED - set ANTHROPIC_API_KEY or authenticate via OAuth
[Daemon] Model initialization skipped - no credentials available
[kai:daemon:space-runtime-service] SpaceRuntimeService started
[kai:daemon:task-agent-manager] TaskAgentManager.rehydrate: attempted=0 succeeded=0 failed=0 selfHealed=0
[Daemon] Enqueued initial job_queue.cleanup job
[Daemon] Job queue processor started
[Daemon] Process watchdog started
[kai:daemon:neoagentmanager] Provisioning Neo session (neo:global)
[kai:daemon:neoagentmanager] Created new Neo session
[kai:daemon:agentsession neo:global] mcp.attach {"event":"mcp.attach","sessionId":"neo:global","action":"merge","servers":["db-query","fetch-mcp","neo-action","neo-query"]}
[kai:daemon:neoagentmanager] Neo session provisioned
[Daemon] Neo agent provisioned
[Daemon] Worktree orphan cleanup complete
[kai:cli:prod-server] Room orchestration is handled by RoomAgentService
[Daemon] Worktree TTL reaper complete
[kai:cli:prod-server] Serving 48 embedded web assets
[kai:cli:prod-server]
Production server running!
[kai:cli:prod-server]    UI: http://localhost:9283
[kai:cli:prod-server]    WebSocket: ws://localhost:9283/ws
[kai:cli:prod-server]
Press Ctrl+C to stop
```

Installed package checks:

```text
--- neokai/package.json FOUND
"version": "0.24.0"

--- neokai/node_modules/@neokai/cli-linux-x64/package.json FOUND
"name": "@neokai/cli-linux-x64"
"version": "0.24.0"
"os": ["linux"]
"cpu": ["x64"]

--- neokai/node_modules/@neokai/cli-linux-x64/bin/kai FOUND
108579136

--- neokai/node_modules/@anthropic-ai/claude-agent-sdk/package.json MISSING
--- neokai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json MISSING
--- neokai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude MISSING
```

Conclusion: published package installs and starts in a clean Linux x64 container. No SDK `cli.js` resolution error appears during startup. The SDK npm packages are not installed into the global package tree because the compiled NeoKai binary bundles JS code and resolves/downloads the native SDK CLI at first SDK use.

### 2. Clean npm global-prefix install on macOS x64

Command shape:

```bash
tmp=$(mktemp -d /tmp/neokai-global-test.XXXXXX)
npm_config_prefix="$tmp/prefix" npm install -g neokai@0.24.0
"$tmp/prefix/bin/kai" --version
"$tmp/prefix/bin/kai" --db-path /tmp/test-neokai-global >"$tmp/kai-start.log" 2>&1 &
sleep 8
```

Observed output:

```text
added 2 packages in 690ms
0.24.0
kai_start_status=still_running
```

Startup log:

```text
NeoKai Server
   Database: /tmp/test-neokai-global
```

Installed package tree excerpt:

```text
prefix/
  bin/kai
  lib/node_modules/neokai/
    bin/kai.js
    node_modules/.bin/kai
    node_modules/@neokai/cli-darwin-x64/bin/kai
    node_modules/@neokai/cli-darwin-x64/package.json
```

Conclusion: published package installs and starts on macOS x64. No `cli.js` error appears at `kai --version` or server startup.

### 3. Linux x64 install-resolution check via npm selectors

Command shape:

```bash
tmp=$(mktemp -d /tmp/neokai-global-test.XXXXXX)
npm_config_prefix="$tmp/prefix" npm_config_os=linux npm_config_cpu=x64 npm install -g neokai@0.24.0
```

Observed metadata from installed package tree:

```text
--- neokai FOUND
"version": "0.24.0"
"optionalDependencies": {
  "@neokai/cli-darwin-arm64": "0.24.0",
  "@neokai/cli-darwin-x64": "0.24.0",
  "@neokai/cli-linux-x64": "0.24.0",
  "@neokai/cli-linux-arm64": "0.24.0"
}

--- neokai/node_modules/@neokai/cli-linux-x64 FOUND
"name": "@neokai/cli-linux-x64"
"version": "0.24.0"
"os": ["linux"]
"cpu": ["x64"]
"bin": { "kai": "bin/kai" }
```

Attempting to run the Linux binary on macOS produced the expected host mismatch error:

```text
(eval):1: exec format error: /tmp/neokai-linux-bin.HZBK8s/pkg/package/bin/kai
linux_kai_start_exit=126
```

Conclusion: npm can select/install the Linux optional dependency. The Docker test above now confirms real Linux x64 startup too.

### 4. SDK 0.2.141 package structure inspection

`npm pack @anthropic-ai/claude-agent-sdk@0.2.141` showed no `cli.js` in the SDK tarball. Contents included:

```text
LICENSE.md
README.md
agentSdkTypes.d.ts
assistant.d.ts
assistant.mjs
bridge.d.ts
bridge.mjs
browser-sdk.d.ts
browser-sdk.js
manifest.json
manifest.zst.json
package.json
sdk-tools.d.ts
sdk.d.ts
sdk.mjs
```

SDK `package.json` optional dependencies:

```json
{
  "optionalDependencies": {
    "@anthropic-ai/claude-agent-sdk-linux-x64": "0.2.141",
    "@anthropic-ai/claude-agent-sdk-linux-arm64": "0.2.141",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl": "0.2.141",
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl": "0.2.141",
    "@anthropic-ai/claude-agent-sdk-darwin-x64": "0.2.141",
    "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.2.141",
    "@anthropic-ai/claude-agent-sdk-win32-x64": "0.2.141",
    "@anthropic-ai/claude-agent-sdk-win32-arm64": "0.2.141"
  },
  "claudeCodeVersion": "2.1.141"
}
```

`npm pack @anthropic-ai/claude-agent-sdk-darwin-arm64@0.2.141` showed platform package contents:

```text
LICENSE.md
README.md
claude
package.json
```

Platform package metadata:

```json
{
  "name": "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "version": "0.2.141",
  "description": "Native CLI binary for @anthropic-ai/claude-agent-sdk on darwin-arm64",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["claude", "README.md", "LICENSE.md"]
}
```

Direct SDK install on the host installed the matching host optional dependency nested under SDK dependencies:

```text
FOUND_DARWIN_X64
-rwxr-xr-x ... 200M ... claude
{"name":"@anthropic-ai/claude-agent-sdk-darwin-x64","version":"0.2.141",...}
```

Conclusion: SDK optional dependencies work for native npm install on host. They are not separate dependencies of `neokai`; they are nested optional dependencies of the SDK package when SDK itself is installed by npm.

## Code review findings

### `prod-entry.ts`

Current `packages/cli/prod-entry.ts` no longer imports or embeds SDK `cli.js`:

```ts
// The SDK CLI binary is no longer embedded in the compiled binary.
// Instead, the runtime resolver (sdk-cli-resolver.ts) downloads it
// on first use and caches it at ~/.neokai/sdk/. This keeps the
// compiled binary ~66 MB instead of ~266 MB.
```

No `cli.js` embedding remains in this file.

### `sdk-cli-resolver.ts`

Current `packages/daemon/src/lib/agent/sdk-cli-resolver.ts` supports SDK 0.2.141 structure:

- Maps platform to package names such as `@anthropic-ai/claude-agent-sdk-darwin-arm64`, `@anthropic-ai/claude-agent-sdk-linux-x64`, or musl variants.
- Uses `claude` / `claude.exe` binary names.
- Resolves native optional dependency from `node_modules` in dev mode.
- Checks cache at `~/.neokai/sdk/claude-<version>-<os>-<arch>[-musl]/claude`.
- Downloads SDK platform package directly from npm registry when bundled binary has no node_modules.
- Keeps legacy `cli.js` fallback only for SDK versions before `0.2.141`.

This is consistent with SDK 0.2.141.

## Failure point analysis

No startup failure reproduced on the available executable platform.

Potential failure points if a user reports breakage:

1. **Old published binary built before resolver fix**
   - Symptom: binary strings or stack trace reference `@anthropic-ai/claude-agent-sdk/cli.js` as required startup dependency.
   - Current published 0.24.0 binary still contains legacy `cli.js` strings, but source maps/minified bundled code also contains comments and fallback branches. Startup did not fail, so strings alone are not proof of active failure.

2. **SDK query execution in offline/restricted network environment**
   - Bundled binary distribution does not include SDK platform binary as npm dependency.
   - Resolver downloads SDK native binary on first use from npm and caches it.
   - If network or `curl` is unavailable, `resolveSDKCliPath()` returns `undefined`; SDK may then fail depending on fallback behavior and local Claude Code install.
   - This was not exercised by `kai --db-path`; startup does not necessarily invoke SDK query execution.

3. **SDK query execution path not covered by startup smoke**
   - Linux startup now passes in Docker.
   - `kai --db-path` starts the server but does not necessarily invoke an SDK query.
   - First-use SDK binary download/cache should be tested separately with credentials or a controlled resolver diagnostic.

## Answers to requested questions

### Does `npm install -g neokai@0.24.0` work?

Yes. Clean Linux x64 Docker install and clean macOS x64 npm-prefix install both worked.

### Does compiled binary start successfully?

Yes on Linux x64 Docker and macOS x64. `kai --db-path /tmp/test-neokai-global` stayed running past the smoke-test wait and printed the server startup banner.

### Does SDK platform binary get installed via npm optionalDependencies?

For direct `npm install -g @anthropic-ai/claude-agent-sdk@0.2.141`, yes: npm installs the host-specific SDK platform optional dependency nested under SDK dependencies.

For `npm install -g neokai@0.24.0`, the SDK package is not present as a runtime `node_modules` dependency of the installed `neokai` package because NeoKai ships a compiled binary. Therefore SDK optional dependency installation is not the mechanism used by the global `neokai` package. Runtime SDK binary resolution depends on `sdk-cli-resolver.ts` downloading/caching the platform package, or finding an already installed SDK/platform binary in development contexts.

### Does `prod-entry.ts` need update?

No for current source. It already removed the embedded `cli.js` import and delegates SDK CLI handling to `sdk-cli-resolver.ts`.

If an older release branch still has `prod-entry.ts` embedding `cli.js`, that branch needs the current resolver architecture backported.

## Recommendations

1. Keep current `prod-entry.ts` and `sdk-cli-resolver.ts` architecture.
2. Add CI smoke test for published package on Linux x64 so this remains covered automatically:
   - clean container
   - `npm install -g neokai@0.24.0`
   - `kai --version`
   - `kai --db-path /tmp/test`
3. Add deeper SDK-path smoke if credentials/proxy allow:
   - trigger one minimal SDK query or resolver diagnostic path
   - verify first-use SDK binary download/cache succeeds
   - verify error message when offline/curl unavailable is actionable
4. Consider release packaging option: include SDK platform binary in `@neokai/cli-*` packages only if first-use network download is unacceptable. Tradeoff: package size increases by about 60 MB compressed / about 200 MB unpacked per platform.

## Sources and evidence

- Published npm metadata: `npm view neokai@0.24.0 optionalDependencies version --json`
- Published package install in Docker: `docker run --rm node:22-bookworm ... npm install -g neokai@0.24.0`
- Published package install on host: `npm_config_prefix=<tmp> npm install -g neokai@0.24.0`
- SDK package tarball: `npm pack @anthropic-ai/claude-agent-sdk@0.2.141`
- SDK platform tarball: `npm pack @anthropic-ai/claude-agent-sdk-darwin-arm64@0.2.141`
- Source files inspected:
  - `packages/cli/prod-entry.ts`
  - `packages/daemon/src/lib/agent/sdk-cli-resolver.ts`
  - `scripts/build-binary.ts`
  - `scripts/package-npm.ts`
