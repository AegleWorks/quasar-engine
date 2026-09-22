# fix-all Specification

## Purpose
Provide document-scoped BatchFixer with equivalenceKey filtering (project/solution scope out).

## Requirements

### Requirement: Document BatchFixer with equivalenceKey
The system MUST provide BatchFixer for document scope: collect diagnostics, invoke fixer per diagnostic, filter by same equivalenceKey, and apply as one batch via transact(). Project/solution scope is OUT.

#### Scenario: Document Fix-All applies
- GIVEN N same-key diagnostics in one document
- WHEN Fix-All runs
- THEN all non-overlapping fixes apply in one transact

#### Scenario: Bounded multipass terminates
- GIVEN cyclically re-triggering fixes
- WHEN passes exceed 10 or a cycle is detected
- THEN BatchFixer stops and reports a cycle warning
