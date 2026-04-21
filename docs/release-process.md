# Release Process

Releases go directly from the `dev` branch via version tags.

## Steps

### 1) Bump version and update changelog

Create a branch from `dev`, bump the version in all `package.json` files, update `CHANGELOG.md`, and run `bun install` to update `bun.lock`:

```bash
git checkout -b release/vX.Y.Z origin/dev
# Update version in all 7 package.json files (root + 6 packages)
# Add CHANGELOG.md entry
bun install
git commit -m "chore(release): bump version to X.Y.Z"
git push -u origin release/vX.Y.Z
```

Open a PR: `release/vX.Y.Z` → `dev`

### 2) Tag after merge to `dev`

Once the version bump PR is merged to `dev`:

```bash
git checkout dev
git pull --ff-only origin dev
git tag vX.Y.Z
git push origin vX.Y.Z
```

`release.yml` is triggered by `v*` tags and validates:

- Tagged commit is on `dev`
- Package versions match the tag version
- CI passed for the tagged commit

### 3) GitHub Release

The release pipeline creates a GitHub Release automatically. If it fails (e.g., auto-generated notes are too long), create it manually:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```
