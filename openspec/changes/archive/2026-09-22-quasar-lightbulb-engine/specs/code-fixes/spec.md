# code-fixes Specification

## Purpose
Separate fixes from analyzers via pure CodeFixProvider registry with atomic application.

## Requirements

### Requirement: Pure CodeFixProvider registry
The system MUST separate fixes from analyzers via CodeFixProvider registry keyed by diagnostic code; providers SHALL return atomic FixOperation[] and MUST NOT mutate documents.

#### Scenario: Fix resolves by code
- GIVEN a diagnostic with stable code X
- WHEN the host queries fixes for X
- THEN the matching provider returns FixOperation[]

#### Scenario: No provider registered
- GIVEN a code with no provider
- WHEN fixes are requested
- THEN the host returns empty with no error

### Requirement: Atomic multi-op fixes
FixOperation[] MUST apply atomically per diagnostic (all-or-nothing); the system MUST reject the whole fix on overlap.

#### Scenario: Overlapping ops rejected
- GIVEN a fix whose ops overlap applied edits
- WHEN BatchFixer applies it
- THEN the entire fix is discarded and others proceed
