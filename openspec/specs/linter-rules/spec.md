# linter-rules Specification

## Purpose
Migrate all 4 Linter closure rules to FixOperation[] providers.

## Requirements

### Requirement: Closure fixes migrated to FixOperation[]
All 4 Linter closure rules MUST migrate to FixOperation[] providers; legacy closures SHALL remain behind flag until migration passes.

#### Scenario: Migrated rule output
- GIVEN a migrated rule violation
- WHEN the fix is applied
- THEN the output equals the legacy closure result

#### Scenario: Adjacent-range boundary
- GIVEN two fixes touching at edge
- WHEN they are applied together
- THEN edge-touching is allowed and true overlap is rejected
