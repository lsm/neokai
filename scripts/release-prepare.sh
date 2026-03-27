#!/bin/bash
# Prepare a protected-branch release by syncing main into a branch based on dev.
#
# Why this exists:
# - main and dev are protected; direct pushes are blocked.
# - PRs to main must come from dev.
# - If histories drift, dev -> main PRs can show noisy conflicts.
#
# This script creates a prep branch from origin/dev, syncs origin/main into it,
# pushes it, and (optionally) opens a PR to dev.
#
# Usage:
#   ./scripts/release-prepare.sh --version 0.8.0
#   ./scripts/release-prepare.sh --version 0.8.0 --no-pr
#   ./scripts/release-prepare.sh --version 0.8.0 --branch release/0.8.0-sync

set -euo pipefail

REMOTE='origin'
DEV_BRANCH='dev'
MAIN_BRANCH='main'
VERSION=''
BRANCH=''
PUSH=1
CREATE_PR=1

usage() {
  cat <<'EOF'
Usage: scripts/release-prepare.sh --version <x.y.z> [options]

Options:
  --version <x.y.z>   Required release version (e.g. 0.8.0)
  --branch <name>     Branch name to create (default: release/<version>-sync-main-into-dev)
  --remote <name>     Git remote (default: origin)
  --no-push           Do not push the branch
  --no-pr             Do not create a PR
  -h, --help          Show this help

What this does:
1) Fetches remote refs
2) Creates a branch from origin/dev
3) Syncs origin/main into the branch:
   - If main-only commits are merge commits only, uses `git merge -s ours`
     to keep dev content while stitching history.
   - Otherwise performs a normal merge and stops on conflicts.
4) Pushes the branch
5) Optionally opens a PR: <new branch> -> dev
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION=${2:-}
      shift 2
      ;;
    --branch)
      BRANCH=${2:-}
      shift 2
      ;;
    --remote)
      REMOTE=${2:-}
      shift 2
      ;;
    --no-push)
      PUSH=0
      shift
      ;;
    --no-pr)
      CREATE_PR=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo 'Error: --version is required.' >&2
  usage
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="release/${VERSION}-sync-main-into-dev"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Error: working tree is not clean. Commit/stash changes first.' >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

echo "Fetching $REMOTE..."
git fetch "$REMOTE" --prune

if ! git show-ref --verify --quiet "refs/remotes/$REMOTE/$DEV_BRANCH"; then
  echo "Error: missing remote branch $REMOTE/$DEV_BRANCH" >&2
  exit 1
fi

if ! git show-ref --verify --quiet "refs/remotes/$REMOTE/$MAIN_BRANCH"; then
  echo "Error: missing remote branch $REMOTE/$MAIN_BRANCH" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "Error: local branch '$BRANCH' already exists." >&2
  exit 1
fi

echo "Creating branch $BRANCH from $REMOTE/$DEV_BRANCH..."
git switch -c "$BRANCH" "$REMOTE/$DEV_BRANCH"

MAIN_ONLY_COUNT=$(git rev-list --count "$REMOTE/$DEV_BRANCH..$REMOTE/$MAIN_BRANCH")
DEV_ONLY_COUNT=$(git rev-list --count "$REMOTE/$MAIN_BRANCH..$REMOTE/$DEV_BRANCH")
MAIN_ONLY_NON_MERGE=$(git rev-list --count --no-merges "$REMOTE/$DEV_BRANCH..$REMOTE/$MAIN_BRANCH")

echo "Divergence:"
echo "  main-only commits: $MAIN_ONLY_COUNT"
echo "  dev-only commits:  $DEV_ONLY_COUNT"

if [[ "$MAIN_ONLY_COUNT" -eq 0 ]]; then
  echo 'No main-only commits; nothing to sync.'
else
  if [[ "$MAIN_ONLY_NON_MERGE" -eq 0 ]]; then
    echo 'Main-only commits are merge commits only; using strategy ours to stitch history.'
    git merge -s ours "$REMOTE/$MAIN_BRANCH" -m "chore(release): sync main into dev history for v$VERSION"
  else
    echo 'Main has non-merge commits; running normal merge.'
    echo 'If conflicts occur, resolve them, commit, and re-run push/PR manually.'
    git merge --no-ff "$REMOTE/$MAIN_BRANCH" -m "chore(release): merge main into dev for v$VERSION"
  fi
fi

if [[ "$PUSH" -eq 1 ]]; then
  echo "Pushing $BRANCH..."
  git push -u "$REMOTE" "$BRANCH"
else
  echo '--no-push set; skipping push.'
fi

if [[ "$CREATE_PR" -eq 1 ]]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    echo "Creating PR $BRANCH -> $DEV_BRANCH..."
    gh pr create \
      --base "$DEV_BRANCH" \
      --head "$BRANCH" \
      --title "chore(release): sync main into dev for v$VERSION" \
      --body "## Summary\n- prepare release v$VERSION by syncing main ancestry into dev\n- keep dev content as source of truth while removing merge-conflict churn for dev -> main PR\n\n## Notes\n- branches are protected; this PR exists so sync can land via normal review/CI flow\n- after this merges, open release PR: dev -> main" || true
  else
    echo 'gh CLI not available or not authenticated; skipping PR creation.'
  fi
else
  echo '--no-pr set; skipping PR creation.'
fi

echo ''
echo 'Next steps:'
echo "1) Merge PR: $BRANCH -> $DEV_BRANCH"
echo "2) Open release PR: $DEV_BRANCH -> $MAIN_BRANCH (title: release: v$VERSION)"
echo "3) After merge to main, tag: git tag -a v$VERSION -m 'NeoKai v$VERSION' && git push $REMOTE v$VERSION"
