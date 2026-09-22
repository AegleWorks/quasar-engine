# diagnostics Specification

## Purpose
Carry stable codes plus opaque data preserved verbatim through round-trip.

## Requirements

### Requirement: Opaque data + stable codes
Diagnostics MUST carry stable code plus opaque data preserved verbatim through publishDiagnostics to codeAction round-trip (Monaco-safe); the host SHALL forward code+data without dropping.

#### Scenario: Round-trip preserves data
- GIVEN a diagnostic with code+data
- WHEN it is resolved through codeAction
- THEN the provider receives identical code+data

#### Scenario: Missing data tolerated
- GIVEN a legacy diagnostic without data
- WHEN a fix is requested
- THEN resolution proceeds by code alone
