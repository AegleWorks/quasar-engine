# Tasks: Quasar Lightbulb Engine

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 800-1000 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | U1→U2→U3 sliceable; size:exception approved |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Types+registries+examples | PR 1 | quasar Fixes tests | N/A (pure registry, no runtime) | Fixes/ + Types/diagnostics.ts removable |
| 2 | Validators strip+Linter port | PR 2 | quasar Linter tests | quasar model tests | Semantic validators + Linter.ts revert to closures |
| 3 | Host+BatchFixer+entry docs | PR 3 | quasar BatchFixer tests | N/A (headless batch) | LightbulbHost/BatchFixer removable |

## Phase 1: Foundation — Types + Registries

- [x] 1.1 Modify `src/Types/diagnostics.ts` add `data`, `equivalenceKey`, `CodeActionKind`
- [x] 1.2 Create `src/Fixes/CodeFixRegistry.ts` with `register(code,provider)`, `get(code)`
- [x] 1.3 Create `src/Fixes/RefactoringRegistry.ts` with `match(node,offset,source)` + preview
- [x] 1.4 Create `src/Fixes/refactorings/combineBolds.ts` merge adjacent bolds
- [x] 1.5 Create `src/Fixes/refactorings/extractTemplate.ts` selection-to-template

## Phase 2: Core — Host, BatchFixer, Ports

- [x] 2.1 Create `src/Fixes/LightbulbHost.ts` ranked query, kind mapping, Fix-All candidate
- [x] 2.2 Create `src/Fixes/BatchFixer.ts` doc scope, DESC sort, overlap reject, ≤10 passes
- [x] 2.3 Modify `src/Semantic/validators.ts` strip embedded fixes, emit code+data only
- [x] 2.4 Modify `src/Linter/Linter.ts` port 4 closures to providers, keep legacy flag
- [x] 2.5 Modify `src/Plugins/PluginAPI.ts` + `src/Plugins/PluginRegistry.ts` add contributions

## Phase 3: Entry docs + Tests

- [x] 3.1 Modify `src/Model/DocumentModel.ts` BatchFixer entry docs (no transact change)
- [x] 3.2 Unit: registry miss, atomic reject, edge-touch, data round-trip in `EditConflicts` tests
- [x] 3.3 Integration: doc Fix-All, multipass/cycle, Linter parity (4 rules) in model tests
