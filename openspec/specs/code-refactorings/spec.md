# code-refactorings Specification

## Purpose
Resolve context-triggered refactorings from RedNode and offset with preview.

## Requirements

### Requirement: Context refactoring providers
The system MUST resolve refactorings from RedNode+offset without diagnostic; providers SHOULD supply preview via applyEditsToSource without mutating.

#### Scenario: Combine bolds
- GIVEN adjacent bold nodes at offset
- WHEN refactorings are requested
- THEN combine-bolds is offered with preview

#### Scenario: No applicable context
- GIVEN an offset with no matching context
- WHEN refactorings are requested
- THEN the result is empty
