# Changelog

All notable changes to NeoKai will be documented in this file.

## [0.6.1] - 2026-03-12

### Fixed
- **Configuration**: Fixed kai binary not using ANTHROPIC_BASE_URL from environment and settings.json
  - Preserve user's custom ANTHROPIC_BASE_URL from environment/settings
  - Clear ANTHROPIC_BASE_URL when not user-configured (use default)
  - Preserve all user-configured environment variables from settings.json
  - Improved code clarity and variable naming (renamed `originalBaseUrl` to `userConfiguredBaseUrl`)

## [0.6.0] - 2026-02-?? (date may vary)

### Added
- Enhanced session management and state synchronization
- Improved E2E test reliability with dev proxy

### Fixed
- Various bug fixes and improvements

## [0.5.2] - 2026-02-?? (date may vary)

### Fixed
- Bug fixes and improvements

## [0.5.1] - 2026-02-?? (date may vary)

### Fixed
- Bug fixes and improvements

## [0.5.0] - 2026-02-?? (date may vary)

### Added
- New features and improvements

## [0.4.0] - 2026-01-?? (date may vary)

### Added
- New features and improvements

## [0.3.0] - 2026-01-?? (date may vary)

### Added
- Initial release features
