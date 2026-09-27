# platform-skills Specification

## Purpose
How kata installs itself into a host platform's own directories and how it stays honest about the differences: capability-based adapters that declare what a platform provides, an installation and update path that never overwrites what it did not write, and a generic fallback so a platform kata does not know about still gets a working, clearly-labelled experience.
## Requirements
### Requirement: Capability-based adapters
The installer SHALL model platform support as capabilities such as skills, hooks, sub-agents, and model selection rather than assuming identical tool features.

#### Scenario: Partial platform support
- **WHEN** a platform supports Skills but not write hooks
- **THEN** the installer SHALL install the Skill adapter and declare guard enforcement as CLI/CI-only

### Requirement: Safe installation and update
The installer SHALL support project/global scopes, detect owned files by manifest and hash, preserve user-owned files, and provide idempotent update and uninstall operations.

#### Scenario: User customization during update
- **WHEN** a generated adapter file has been modified by the user
- **THEN** `kata update` SHALL report the conflict and SHALL NOT overwrite it without explicit confirmation

### Requirement: Generic fallback adapter
The distribution SHALL provide a generic adapter using repository instructions and explicit CLI commands for tools without native Skill support.

#### Scenario: Unsupported tool
- **WHEN** `kata init` cannot identify a native adapter
- **THEN** it SHALL offer the generic adapter and report which automatic hooks are unavailable

