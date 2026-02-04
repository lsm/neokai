# Contributing to NeoKai

Thank you for your interest in contributing to NeoKai! This document provides guidelines and information for contributors.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `bun install`
4. Create a new branch from `dev` for your changes

## Branching Strategy

This project uses a two-branch workflow to optimize development speed while maintaining quality:

### Branches

- **`dev`** (default branch) - Active development branch
  - All feature branches should target `dev`
  - PRs to `dev` run fast checks only (lint, type check, unit tests, integration tests)
  - E2E tests run automatically **after** merge to `dev`
  - Provides fast feedback loops for rapid iteration

- **`main`** - Production-ready code
  - Only accepts PRs from `dev` branch
  - Full test suite runs for PRs to `main` (including E2E tests)
  - Represents stable, release-ready code

### Workflow

1. **Feature Development**
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/my-feature
   # make changes
   git push origin feature/my-feature
   # create PR targeting dev
   ```

2. **After PR is merged to `dev`**
   - E2E tests run automatically
   - Monitor CI to ensure all tests pass
   - Dev branch remains stable for other contributors

3. **Releasing to `main`**
   - Create PR from `dev` to `main`
   - Full test suite runs (all tests including E2E)
   - After merge, production deployment can proceed

### CI/CD Pipeline

| Event | Target Branch | Tests Run |
|-------|---------------|-----------|
| PR → `dev` | `dev` | Lint, type check, unit tests, integration tests (⚡ **fast**) |
| Merge to `dev` | `dev` | **All** tests including E2E (📊 comprehensive) |
| PR → `main` | `main` | **All** tests including E2E (📊 comprehensive) |
| Merge to `main` | `main` | **All** tests including E2E (📊 comprehensive) |

**Why this approach?**
- **Speed**: Skip expensive E2E tests during active feature development
- **Quality**: Full validation before production deployment
- **Stability**: Dev branch validated with E2E after merge

### 🔒 Merge Enforcement

To maintain code quality and workflow integrity, only the `dev` branch can merge into `main`. This protection is enforced automatically by CI - no manual approval needed.

**How it works:**
- The `enforce-merge-policy` CI job runs on every PR to `main`
- It validates that the source branch is `dev` and nothing else
- Attempting to create a PR from any other branch to `main` will fail immediately

**What happens on bypass attempt:**
- The CI check will fail with a clear error message: `❌ Only 'dev' branch can merge into 'main'. Current source: <branch>`
- The PR cannot be merged until the source branch is changed to `dev`
- This prevents accidental or intentional bypass of the intended workflow

**Proper workflow reminder:**
1. Feature branches → `dev` (fast feedback, quick iteration)
2. After `dev` is validated with E2E tests → create PR from `dev` to `main`

This ensures all code going to production has been properly validated through the dev branch.
## Development Guidelines

### Code Style

- Follow the existing code style in the codebase
- Run `bun run lint` to check for linting errors
- Run `bun run format` to format code automatically

### Testing

- Write tests for new features and bug fixes
- Ensure all tests pass before submitting a PR: `bun test`
- For E2E tests: `cd packages/e2e && bun test`

### Commit Messages

Use clear and descriptive commit messages following conventional commit format:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for test-related changes
- `refactor:` for code refactoring
- `chore:` for maintenance tasks
- `ci:` for CI/CD changes

Example:
```
feat: add model switching support in coordinator mode

- Add model parameter to coordinator options
- Update UI to show current model
- Add tests for model switching
```

## Pull Request Process

1. **Ensure your branch is up to date** with `dev`
   ```bash
   git checkout dev
   git pull origin dev
   git checkout your-feature-branch
   git rebase dev
   ```

2. **Create a pull request** targeting the `dev` branch

3. **Provide a clear description** of your changes
   - What problem does it solve?
   - How does it work?
   - Are there any breaking changes?

4. **Wait for CI checks to pass**
   - PRs to dev will skip E2E tests (faster feedback)
   - All other checks must pass

5. **Request review** from maintainers

6. **Address feedback** from reviewers
   - Make requested changes
   - Push updates to your branch

7. **Merge** will happen after approval and passing checks

## Setting Up Your Development Environment

### Prerequisites

- [Bun](https://bun.sh/) 1.3.8 or later
- Node.js 20.x or later (for compatibility)
- Git

### Installation

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/neokai.git
cd neokai

# Add upstream remote
git remote add upstream https://github.com/lsm/neokai.git

# Install dependencies
bun install

# Build packages
bun run build
```

### Running Locally

```bash
# Start the development server
cd packages/cli
bun run dev

# Run tests
bun test

# Run specific package tests
cd packages/daemon
bun test
```

### Environment Variables

Create a `.env` file in the root directory:

```bash
ANTHROPIC_API_KEY=your_api_key_here
GLM_API_KEY=your_glm_key_here  # Optional, for GLM provider
```

## Questions or Issues?

If you have questions or run into issues:
- Check [existing issues](https://github.com/lsm/neokai/issues) on GitHub
- Open a new issue with a clear description
- Join our community discussions

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Help others learn and grow
- Focus on what is best for the community

Thank you for contributing to NeoKai! 🚀
