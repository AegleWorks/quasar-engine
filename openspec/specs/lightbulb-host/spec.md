# lightbulb-host Specification

## Purpose
Return ranked LSP-kinded quickfix, refactor, and source.fixAll actions.

## Requirements

### Requirement: Ranked LSP-kinded resolution
The host MUST return ranked quickfix/refactor/source.fixAll actions with LSP kinds; manual suggestions SHALL be distinguished from automatic fixes.

#### Scenario: Ranked lightbulb menu
- GIVEN fixes and refactorings at a range
- WHEN the lightbulb is invoked
- THEN actions return ranked with kinds and preview

#### Scenario: Fix-All surfacing
- GIVEN a safe automatic fix
- WHEN it is exposed as a Fix-All candidate
- THEN it carries kind source.fixAll
