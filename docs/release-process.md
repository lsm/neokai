# Release Process (Protected `dev` / `main`)

This project uses protected branches:

- `dev` is the integration branch (latest code)
- `main` is production-ready
- PRs to `main` must come from `dev`

When `dev` and `main` histories drift, release PRs can become conflict-heavy. The safest flow is a **two-PR release**.

## Recommended flow

### 1) Prepare a sync branch from `dev`

Run:

```bash
./scripts/release-prepare.sh --version 0.8.0
```

This script:

1. Fetches `origin/dev` + `origin/main`
2. Creates `release/0.8.0-sync-main-into-dev` from `origin/dev`
3. Syncs `origin/main` into that branch
   - If `main`-only commits are merge commits, it uses `git merge -s ours` to keep `dev` content while stitching ancestry
   - If `main` has real non-merge commits, it runs a normal merge (and may require manual conflict resolution)
4. Pushes the branch
5. Opens a PR to `dev` (if `gh` is installed/authenticated)

### 2) Merge sync PR into `dev`

Merge PR:

- `release/0.8.0-sync-main-into-dev` -> `dev`

This keeps branch protections intact and prevents direct pushes.

### 3) Open release PR

After step 2 is merged, open:

- `dev` -> `main`

Suggested title:

- `release: v0.8.0`

### 4) Tag after merge to `main`

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.8.0 -m "NeoKai v0.8.0"
git push origin v0.8.0
```

`release.yml` is triggered by `v*` tags and validates:

- tagged commit is on `main`
- package versions match the tag version
- CI passed for the tagged commit

## Why this works

- `dev` remains source of truth
- no direct pushes to protected branches
- conflicts are handled before the `dev -> main` release PR
- release PR stays clean and reviewable
