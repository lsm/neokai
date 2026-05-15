# npm global install SDK binary investigation

Date: 2026-05-15
Task: #390 — Investigate npm global install SDK binary issue

## Executive summary

`npm install -g neokai@0.24.0` works on the available host test platform (macOS x64) for startup-level validation:

- `kai --version` prints `0.24.0`.
- `kai --db-path /tmp/test-neokai-global` starts the server process and stays running past 8 seconds.
- No `cli.js` import error occurs during startup.

The requested clean Docker `linux-x64` test could not run because Docker daemon was unavailable in this environment. A partial Linux install-resolution check with npm platform selectors confirmed `neokai@0.24.0` installs the Linux platform package (`@neokai/cli-linux-x64@0.24.0`), but the Linux binary could not execute on the macOS host (`exec format error`).

SDK 0.2.141 does not ship `cli.js`. It ships SDK JS entrypoints plus platform-native optional dependencies named `@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]`, each containing a native `claude`/`claude.exe` binary. The current source tree already has the correct post-0.2.141 approach: `packages/cli/prod-entry.ts` no longer embeds `cli.js`; `packages/daemon/src/lib/agent/sdk-cli-resolver.ts` resolves the platform package, cache, or downloads the binary from npm.

Recommendation: keep current `prod-entry.ts` architecture. Add release-time smoke coverage for the installed npm package on Linux in CI, because local Docker was unavailable and startup-only validation does not exercise SDK query execution.

## Environment and constraints

- Worktree: `/Users/lsm/.neokai/projects/dev-neokai-ec0a1deb/worktrees/investigate-npm-global-install-sdk-binary-issue`
- Host platform observed from npm behavior: `darwin-x64`
- npm package under test: published `neokai@0.24.0`, not local build
- SDK package inspected: `@anthropic-ai/claude-agent-sdk@0.2.141`

Docker could not be used:

```text
failed to connect to the docker API at unix:///Users/lsm/.orbstack/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/lsm/.orbstack/run/docker.sock: connect: no such file or directory
```

`podman` and `colima` were not installed:

```text
(eval):1: command not found: podman
(eval):1: command not found: colima
```

## Tests performed

### 1. Clean npm global-prefix install on macOS x64

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

### 2. Linux x64 install-resolution check via npm selectors

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

Conclusion: npm can select/install the Linux optional dependency, but real Linux execution still needs Docker/CI validation.

### 3. SDK 0.2.141 package structure inspection

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

3. **Linux-specific runtime behavior**
   - Linux binary could not be executed locally because Docker was unavailable.
   - npm dependency selection for Linux x64 works, but actual process startup and SDK query flow remain unverified on Linux.

## Answers to requested questions

### Does `npm install -g neokai@0.24.0` work?

Yes on clean npm global-prefix macOS x64 test. Linux install selection works, but real Linux execution was blocked by unavailable Docker daemon.

### Does compiled binary start successfully?

Yes on macOS x64. `kai --db-path /tmp/test-neokai-global` stayed running past 8 seconds and printed server startup banner.

### Does SDK platform binary get installed via npm optionalDependencies?

For direct `npm install -g @anthropic-ai/claude-agent-sdk@0.2.141`, yes: npm installs the host-specific SDK platform optional dependency nested under SDK dependencies.

For `npm install -g neokai@0.24.0`, the SDK package is not present as a runtime `node_modules` dependency of the installed `neokai` package because NeoKai ships a compiled binary. Therefore SDK optional dependency installation is not the mechanism used by the global `neokai` package. Runtime SDK binary resolution depends on `sdk-cli-resolver.ts` downloading/caching the platform package, or finding an already installed SDK/platform binary in development contexts.

### Does `prod-entry.ts` need update?

No for current source. It already removed the embedded `cli.js` import and delegates SDK CLI handling to `sdk-cli-resolver.ts`.

If an older release branch still has `prod-entry.ts` embedding `cli.js`, that branch needs the current resolver architecture backported.

## Recommendations

1. Keep current `prod-entry.ts` and `sdk-cli-resolver.ts` architecture.
2. Add or run CI smoke test for published package on Linux x64:
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
- Published package install: `npm_config_prefix=<tmp> npm install -g neokai@0.24.0`
- SDK package tarball: `npm pack @anthropic-ai/claude-agent-sdk@0.2.141`
- SDK platform tarball: `npm pack @anthropic-ai/claude-agent-sdk-darwin-arm64@0.2.141`
- Source files inspected:
  - `packages/cli/prod-entry.ts`
  - `packages/daemon/src/lib/agent/sdk-cli-resolver.ts`
  - `scripts/build-binary.ts`
  - `scripts/package-npm.ts`
