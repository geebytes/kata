# evaluation-and-release Specification

## Purpose
TBD - created by archiving change strata-foundation. Update Purpose after archive.
## Requirements
### Requirement: Cross-platform compatibility fixtures
The project SHALL test that each supported adapter installs the same command manifest, task schema, and guard contract.

#### Scenario: Adapter manifest comparison
- **WHEN** Codex, Claude Code, and OpenCode fixtures are generated
- **THEN** their normalized command and protocol manifests SHALL be equivalent

### Requirement: Workflow evaluation
The evaluation harness SHALL execute the task fixtures a manifest declares and measure acceptance pass rate, repair count, latency and Wiki rejection/promotion counts from what those runs produce. Metrics the runtime cannot observe in process — token and cost usage, and model escalations, which belong to the host platform — SHALL be reported as explicitly unmeasured instead of as zero.

#### Scenario: Repair-rate regression
- **WHEN** a workflow revision raises the measured repair rate past its configured threshold without improving the measured acceptance pass rate
- **THEN** the release evaluation SHALL fail or mark the revision for review

### Requirement: Release safety
Release SHALL require passing core state-machine tests, Wiki governance tests, installer/update/uninstall tests, adapter fixtures, and representative end-to-end workflow evaluations.

#### Scenario: Update would overwrite user files
- **WHEN** the release test detects an unconfirmed overwrite path
- **THEN** the release gate SHALL fail

