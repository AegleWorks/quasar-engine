# Apply Progress: Quasar Lightbulb Engine — Units 1+2

> Unit 1 block below is the merged prior record (untouched). Unit 2 follows it.

## Unit 1 (prior, merged)

# Apply Progress: Quasar Lightbulb Engine — Unit 1

- Change: `quasar-lightbulb-engine`
- Work unit: U1-types-registries-examples (tasks 1.1–1.5)
- Attempt: eng-u1-20260922-01
- Mode: Strict TDD
- Delivery: size:exception (maintainer-approved; full scope 800–1000 lines)
- Date: 2026-09-22

## Completed Tasks

- [x] 1.1 `src/Types/diagnostics.ts`: `data?: unknown`, `equivalenceKey?: string`, `CodeActionKind`
- [x] 1.2 `src/Fixes/CodeFixRegistry.ts`: `registerCodeFix(code, provider)`, `getCodeFix(code)`
- [x] 1.3 `src/Fixes/RefactoringRegistry.ts`: `matchRefactorings(node, offset, source)` + `previewRefactoring`
- [x] 1.4 `src/Fixes/refactorings/combineBolds.ts`: merge adjacent bolds
- [x] 1.5 `src/Fixes/refactorings/extractTemplate.ts`: selection-to-template

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `src/Types/diagnostics.ts` | Modified | Added `data?: unknown`, `equivalenceKey?: string` to `Diagnostic` + `createDiagnostic` options; new `CodeActionKind` union (`quickfix`, `refactor`, `refactor.extract`, `refactor.rewrite`, `source.fixAll`) |
| `src/Types/index.ts` | Modified | Re-export `CodeActionKind` |
| `src/index.ts` | Modified | Re-export `CodeActionKind` |
| `src/Fixes/CodeFixRegistry.ts` | Created | Module-level registry: `registerCodeFix`, `getCodeFix` (undefined on miss), `unregisterCodeFix`; `CodeFixProvider = (diag, { source, node }) => FixOperation[]`, pure by contract |
| `src/Fixes/RefactoringRegistry.ts` | Created | `RefactoringProvider` (`id`, `title`, `kinds`, `match`, `edits` → `SurgicalEdit[]`); `register`/`unregister`/`get`/`matchRefactorings`/`previewRefactoring` (preview via `applyEditsToSource`, no mutation) |
| `src/Fixes/refactorings/combineBolds.ts` | Created | `combine-bolds` (`refactor.rewrite`): merges strictly adjacent bold siblings (`[b]a[/b][b]b[/b]` → `[b]ab[/b]`); gap-separated or lone bolds do not match |
| `src/Fixes/refactorings/extractTemplate.ts` | Created | Pure `extractTemplateEdits(source, selection)` (empty selection → no edits) + `extract-template` (`refactor.extract`) provider operating on the text node under the caret |
| `src/Tests/LightbulbEngineU1.test.ts` | Created | 14 RED-first tests covering all spec scenarios for U1 |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1 | `src/Tests/LightbulbEngineU1.test.ts` | Unit | ✅ 14/14 DiagnosticFixes | ✅ import-resolution failure | ✅ 3/3 pass | ✅ round-trip + legacy + kinds | ✅ none needed |
| 1.2 | `src/Tests/LightbulbEngineU1.test.ts` | Unit | N/A (new) | ✅ import-resolution failure | ✅ 3/3 pass | ✅ basic + miss + overwrite-wins | ✅ none needed |
| 1.3 | `src/Tests/LightbulbEngineU1.test.ts` | Unit | N/A (new) | ✅ import-resolution failure | ✅ 2/2 pass | ✅ match+preview + empty-context | ✅ none needed |
| 1.4 | `src/Tests/LightbulbEngineU1.test.ts` | Unit | N/A (new) | ✅ import-resolution failure | ✅ 3/3 pass | ✅ adjacent + gap-separated + lone | ✅ removed dead helper |
| 1.5 | `src/Tests/LightbulbEngineU1.test.ts` | Unit | N/A (new) | ✅ import-resolution failure | ✅ 3/3 pass | ✅ selection + empty + caret-preview | ✅ simplified textAt |

### Test Summary

- **Total tests written**: 14
- **Total tests passing**: 14
- **Layers used**: Unit (14), Integration (0), E2E (0)
- **Approval tests** (refactoring): None — no refactoring tasks (1.1 is an additive type change guarded by the 14/14 DiagnosticFixes safety net)
- **Pure functions created**: 4 (`extractTemplateEdits`, `adjacentBoldPair`/`closest` internals, both `edits` implementations are pure)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run src/Tests/LightbulbEngineU1.test.ts` → 1 file passed, 14/14 tests passed |
| Runtime harness command/scenario and exact result | N/A (pure registry + source-text preview; no runtime boundary exists — per tasks.md forecast for U1) |
| Rollback boundary | `src/Fixes/` directory + `src/Tests/LightbulbEngineU1.test.ts` removable; `src/Types/diagnostics.ts`, `src/Types/index.ts`, `src/index.ts` revert to additive-only diff. No other files touched. 2.x/3.x untouched. |

## Verification

- `npm run typecheck`: clean (no output, exit 0)
- `npm test`: 75 passed, 1 skipped (pre-existing skip), 1670 passed, 1 skipped

## Deviations from Design

- Registry API is module-level functions (`registerCodeFix`/`getCodeFix`, `registerRefactoring`/`matchRefactorings`/`previewRefactoring`) rather than class instances. Same contracts (`register(code, provider)`, `get(code)`, `match(node, offset, source)` + preview), no instantiation ceremony for a global provider table.
- `RefactoringRegistry` additionally exposes `unregister`/`get` (test isolation, future plugin lifecycle for U2's `PluginRegistry` contributions).
- `CodeActionKind` includes generic `'refactor'` alongside the specified `quickfix`/`refactor.extract`/`refactor.rewrite`/`source.fixAll` (LSP-standard parent kind).
- `extractTemplate` wraps selections in `[template]…[/template]`, a new example tag with no renderer support yet — acceptable for a manual (`refactor.extract`) example refactoring; renderer/validator treatment is out of scope for U1.
- `combineBolds` merges only strictly adjacent bolds; whitespace-separated bolds do not match (merging would drop rendered gap text).

## Issues Found

None.

## Remaining Tasks (out of scope for this unit)

- [x] 2.1–2.5 (LightbulbHost, BatchFixer, validator strip, Linter port, Plugins) — done in Unit 2 below
- [ ] 3.1–3.3 (DocumentModel entry docs, unit + integration tests)

---

# Apply Progress: Quasar Lightbulb Engine — Unit 2

- Change: `quasar-lightbulb-engine`
- Work unit: U2-host-batchfixer-ports (tasks 2.1–2.5)
- Attempt: eng-u2-20260922-01
- Mode: Strict TDD
- Delivery: size:exception (maintainer-approved; this unit ~1900 changed lines vs the ~700 guide — see Workload)
- Date: 2026-09-22

## Completed Tasks

- [x] 2.1 `src/Fixes/LightbulbHost.ts`: ranked query, LSP kind mapping (quickfix, refactor.extract/rewrite, source.fixAll), preview, Fix-All candidate
- [x] 2.2 `src/Fixes/BatchFixer.ts`: document scope, equivalenceKey filter, DESC sort, overlap reject (edge-touch allowed), multipass <= 10 with cycle warning, transact() as sole edit path; project/solution scope stub throws UnimplementedError
- [x] 2.3 `src/Semantic/SemanticAnalyzer.ts` (the home of `src/Semantic/validators.ts`, which does not exist as a separate file): stripped embedded fixes from all 11 fix-bearing validators, emit code+data (+equivalenceKey for the 5 automatic codes) only
- [x] 2.4 `src/Linter/Linter.ts`: ported the 4 closure rules to FixOperation[] providers registered in CodeFixRegistry; legacy closures kept behind `legacyFixes` flag (default on) until parity passes
- [x] 2.5 `src/Plugins/PluginAPI.ts` + `src/Plugins/PluginRegistry.ts`: `codeFixes`/`refactorings` contributions + unregister

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `src/Fixes/validatorFixes.ts` | Created | `registerValidatorFixes()` (idempotent): 11 data-driven providers + metas rebuilding the exact validator fix ops; missing data → `[]` |
| `src/Fixes/LightbulbHost.ts` | Created | `LightbulbHost.query` / `queryLightbulb`: range-filtered ranked actions, preview via `applyEditsToSource`, one `source.fixAll` candidate per equivalenceKey; registers builtins on construction |
| `src/Fixes/BatchFixer.ts` | Created | `planFixAll` (filter, per-diagnostic atomicity, DESC, overlap reject) + `fixAll`/`fixAllDocuments` (multipass <= 10, cycle warning, `UnimplementedError` for project/solution); `FixAllTarget.transact` is the sole edit path |
| `src/Fixes/CodeFixRegistry.ts` | Modified | Additive `CodeFixMeta` (`title`, `isAutomatic`, `kind`) + `registerCodeFix(code, provider, meta?)` + `getCodeFixMeta`; unregister drops both (U1 call shapes unchanged) |
| `src/Semantic/SemanticAnalyzer.ts` | Modified | All 11 validators emit `data` (+`equivalenceKey` on the 5 automatic codes) and no longer embed `fixes`; removed now-unused `DiagnosticFix` import |
| `src/Linter/Linter.ts` | Modified | `LinterOptions{legacyFixes,onLegacyFix}`, `LintIssue.data`, `registerLinterFixes()` (4 providers; empty for max-quote-depth/invalid-url-protocol — no safe rewrite), legacy parity closures on the 2 fixable rules |
| `src/Plugins/PluginRegistry.ts` | Modified | `CodeFixContribution` + `codeFixes?`/`refactorings?` on `PluginContribution` (type-only imports, no runtime cycle) |
| `src/Plugins/PluginAPI.ts` | Modified | `registerPlugin` registers fixes/refactorings; `unregisterPlugin` unregisters them |
| `src/Tests/LightbulbEngineU2.test.ts` | Created | 33 RED-first tests covering all U2 spec scenarios |
| 6 existing test files | Modified | `DiagnosticFixes`, `UnknownTags`, `CrossedTags`, `OrphanClosingTags`, `SemanticRules`, `SemanticValidators`: same assertions, fixes now resolved via `registerValidatorFixes()` + `getCodeFix` (minimal helper-level migration) |

## TDD Cycle Evidence

| Task | Test File | Layer | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|-----|-------|-------------|----------|
| 2.1 | `src/Tests/LightbulbEngineU2.test.ts` | Unit | ✅ import-resolution failure | ✅ 33/33 pass | ✅ rank + order + preview + fixAll + kinds + miss + round-trip + legacy-data + range-filter (9 tests) | ✅ fixed kind-test to use a real op; removed dead helper |
| 2.2 | `src/Tests/LightbulbEngineU2.test.ts` | Unit | ✅ import-resolution failure | ✅ 33/33 pass | ✅ one-transact + key filter + overlap + edge-touch + intra-atomic + cycle + maxPasses + default-10 + scope-throws + sole-path + multi-doc + real-model convergence (12 tests) | ✅ converging fakes (static diags would loop to 10); dropped dead target |
| 2.3 | `src/Tests/LightbulbEngineU2.test.ts` | Unit | ✅ import-resolution failure | ✅ 33/33 pass | ✅ 4 auto codes (data+key+provider output) + manual opt-out + no-suggestion empty (6 tests) | ✅ none needed |
| 2.4 | `src/Tests/LightbulbEngineU2.test.ts` | Unit | ✅ import-resolution failure | ✅ 33/33 pass | ✅ parity ×2 output-equal + 2 no-rewrite empties + flag-off (5 tests) | ✅ none needed |
| 2.5 | `src/Tests/LightbulbEngineU2.test.ts` | Unit | ✅ import-resolution failure | ✅ 33/33 pass | ✅ register visible + unregister removes incl. meta (1 test) | ✅ none needed |

### Test Summary

- **Total tests written**: 33
- **Total tests passing**: 33
- **Layers used**: Unit (33), Integration (0 — model integration is U3/3.3), E2E (0)
- **Approval tests** (refactoring): None — no refactoring tasks; the 6 migrated files keep their original assertions behind the new access path
- **Pure functions created**: 11 providers + `planFixAll` + host query path are pure (no document mutation; previews via `applyEditsToSource`)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run src/Tests/LightbulbEngineU2.test.ts` → 1 file passed, 33/33 tests passed |
| Runtime harness command/scenario and exact result | Model-backed Fix-All test inside the suite (real `BBCodeDocumentModel.analyze` → `fixAll` → `'[b]x'` becomes `'[b]x[/b]'`, finding gone); no separate runtime boundary exists for this headless unit |
| Rollback boundary | `src/Fixes/LightbulbHost.ts`, `src/Fixes/BatchFixer.ts`, `src/Fixes/validatorFixes.ts`, `src/Tests/LightbulbEngineU2.test.ts` deletable; `CodeFixRegistry.ts` (drop meta block), `SemanticAnalyzer.ts`, `Linter.ts`, `PluginAPI/Registry.ts` revert per-file; 6 migrated test files revert to embedded-fix assertions. 3.x untouched. |

## Verification

- `npm run typecheck`: clean (exit 0)
- `npm test`: 1703 passed, 1 skipped (pre-existing skip) — full suite green, no regressions

## Deviations from Design

- `src/Semantic/validators.ts` does not exist as a file; the validators live in `src/Semantic/SemanticAnalyzer.ts` — the strip landed there.
- Dual-kind open question resolved as two entries (quickfix + source.fixAll sibling), so clients understanding only quickfix keep working.
- `CodeFixMeta` added alongside (not inside) the U1 provider signature — U1 call shapes unchanged, backward compatible.
- Linter legacy closures deliver through `LinterOptions.onLegacyFix` (the `fix.apply()` signature returns void and cannot carry the rewritten source itself); parity is structural — closure and provider apply the same operations.
- Linter `max-quote-depth` / `invalid-url-protocol` register intentionally empty providers (no safe rewrite exists; unwrapping/rewriting changes what the reader sees) — host stays silent for them, same as the analyzer's fix-less codes.
- `FixAllTarget.transact(edits)` is the sole edit path by interface; the `DocumentModel.transact(Operation[])` wiring is U3/3.1 entry work (no transact change there per tasks.md). `Transaction` has no text-span operation kind, so a direct `Operation[]` translation is not expressible today.
- `fixToSurgicalEdits` drops the closing insert for `wrap_in_tag` (emits only `[tag]`): pre-existing, out of scope, no in-scope provider uses that kind. Flagged for a follow-up, not fixed here.

## Issues Found

- 33 pre-existing tests across 6 files asserted the old embedded-fix coupling (`DiagnosticFixes`, `UnknownTags`, `CrossedTags`, `OrphanClosingTags`, `SemanticRules`, `SemanticValidators`). Migrated to registry resolution with identical assertions — the intended break, not a regression.
- My own initial U2 expectation `'a1bc2d'` was wrong (two original-offset inserts yield `'a1bcd2'`); corrected the test, not the code.
- `NodeId` branding required a cast in the U2 Linter parity helper (`issue.nodeId as NodeId`).

## Carried Decisions

- The `[template]` example tag from U1 has NO renderer/validator — `extractTemplate` stays example-only; rendering support is deferred to the parent change (not this engine change).
- equivalenceKey policy: the 5 render-neutral automatic validators (`deprecated-tag`, `empty-tag`, `unclosed-tag`, `missing-url-protocol`, `box-missing-equals`) opt into Fix-All with key = code; all manual findings carry no key.
- No `src/index.ts` exports for the new engine modules (U1 precedent: registries reachable via the `./src/*` subpath).

## Workload / PR Boundary

- Mode: size:exception (pre-approved for this change; single work unit, no chain slicing — 2.1–2.5 are one cohesive unit)
- Current work unit: U2-host-batchfixer-ports
- Boundary: starts after U1 registries/providers; ends before U3 model entry docs + integration tests
- Changed lines: ~1900 (tracked 581 + new 1269 + registry meta ~50) vs the ~700 guide — overage is scope, not fat: 11 providers + host + batch fixer + 6 forced test migrations + 33 RED-first tests are irreducible for tasks 2.1–2.5; no comments, blank lines, docs, or tests were removed to fit. `size:exception` stands as approved.

## Remaining Tasks (out of scope for this unit)

- [ ] 3.1–3.3 (DocumentModel entry docs, unit + integration tests) — done in Unit 3 below

---

# Apply Progress: Quasar Lightbulb Engine — Unit 3

- Change: `quasar-lightbulb-engine`
- Work unit: U3-entry-docs-tests (tasks 3.1–3.3)
- Attempt: eng-u3-20260922-01
- Mode: Strict TDD
- Delivery: size:exception (pre-approved for this change; this unit ~276 changed lines, within the ~600 guide)
- Date: 2026-09-22

## Completed Tasks

- [x] 3.1 `src/Model/DocumentModel.ts`: BatchFixer entry docs + `asFixAllTarget()` / `fixAll()` wiring; `transact()` untouched
- [x] 3.2 Unit gaps vs U1/U2 suites (through the real model entry, not the U2 synthetic harness): registry miss, atomic reject, edge-touch allow, data round-trip
- [x] 3.3 Integration (live model): document Fix-All end to end + undo, multipass <= 10 with cycle warning, Linter parity for the 4 ported rules

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `src/Model/DocumentModel.ts` | Modified | BatchFixer entry docs + `asFixAllTarget()` (real `FixAllTarget`: fresh diagnostics via `ensureAnalyzed`, node lookup, one-batch-per-pass `transact` via `applyEditsToSource` + single `applyTextUpdate` with `{before,after}` undo push) + `fixAll(key, options?)` delegating to `BatchFixer.fixAll`; `transact(Operation[])` unchanged |
| `src/Tests/LightbulbEngineU3.test.ts` | Created | 7 RED-first tests: 4 unit gaps + 3 integration (end-to-end, multipass bound, 4-rule Linter parity on the live model) |

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3.1 | `src/Tests/LightbulbEngineU3.test.ts` | Unit | ✅ 59/59 (DiagnosticFixes + EditConflicts + ModelCoherence) | ✅ executed: 6× `model.fixAll is not a function` | ✅ 7/7 pass | ✅ miss + atomic + edge-touch + round-trip + e2e + bound + parity (7 cases) | ✅ none needed (61-line additive block, no duplication) |
| 3.2 | `src/Tests/LightbulbEngineU3.test.ts` | Unit | ✅ 59/59 | ✅ same RED run (entry missing) | ✅ 7/7 pass | ✅ 4 named gaps, each with a distinct setup and exact-value assertions | ✅ corrected e2e-adjacent expectation via contract, not code |
| 3.3 | `src/Tests/LightbulbEngineU3.test.ts` | Integration | ✅ 59/59 | ✅ parity test passed on existing APIs (1/7); entry tests failed | ✅ 7/7 pass | ✅ e2e (2-diag doc + full undo unwind) + bound (growing provider, 10/10 + warning) + parity ×4 on live model with apply-back | ✅ none needed |

### Test Summary

- **Total tests written**: 7
- **Total tests passing**: 7
- **Layers used**: Unit (4), Integration (3), E2E (0)
- **Approval tests** (refactoring): None — no refactoring tasks (3.1 is additive; `transact()` untouched by contract)
- **Pure functions created**: 0 (entry is an adapter over the existing pure engine path)

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `npx vitest run src/Tests/LightbulbEngineU3.test.ts` → 1 file passed, 7/7 tests passed |
| Runtime harness command/scenario and exact result | `npm test` (full suite as runtime boundary for this headless unit) → 77 files passed, 1 skipped (pre-existing skip); 1710 passed, 1 skipped (pre-existing skip). `npm run typecheck` → clean (exit 0) |
| Rollback boundary | `src/Tests/LightbulbEngineU3.test.ts` deletable; `src/Model/DocumentModel.ts` revert the entry-docs block (imports + `asFixAllTarget`/`fixAll`, ~61 lines) with `transact()` never touched. No other files touched. |

## Verification

- `npm run typecheck`: clean (exit 0)
- `npm test`: 1710 passed, 1 skipped (pre-existing skip) — full suite green, no regressions (baseline before U3: 1703 passed; +7 new)

## Deviations from Design

- U2 open finding resolved: `Transaction` has no text-span operation kind (all 13 `Operation` kinds address nodes/text objects), so `SurgicalEdit[]` cannot be expressed as `Operation[]` today. The adapter applies one accepted batch via `applyEditsToSource` + a single `applyTextUpdate` (which diffs to one `TextChange` through the incremental pipeline) instead of `transact(Operation[])` — the "sole edit path, one call per pass" contract holds at the `FixAllTarget.transact` level, and the choice is documented on `asFixAllTarget`. No new op kind, no `transact()` change per tasks.md.
- `applyChange` records no undo, so the adapter pushes the `{before, after}` snapshot itself (label `Fix all`); no-op batches push nothing — mirroring `transact()` undoability.
- 3.2 gap tests live in `src/Tests/LightbulbEngineU3.test.ts` (U1/U2 single-file-per-unit precedent) rather than inside `EditConflicts.test.ts`: they pin engine behaviors through the new model entry, and `EditConflicts.test.ts` itself is untouched. The "EditConflicts tests" layer pointer is satisfied by behavior (atomic reject, edge-touch) not by file.
- 3.3 Linter parity runs on the live model (lint `model.redRoot`/`model.source`, provider fix applied back via `applyTextUpdate`, re-converged) rather than repeating U2's static harness — the gap vs U2 is the document round-trip, not the parity values.

## Issues Found

- First GREEN run exposed a real behavior, not a bug: `[b]x[i]y` needs 2 passes because both closers insert at the same offset and same-offset zero-width inserts conflict per the `EditConflicts` contract (one applies, one defers per pass). The test now pins `passes: 2` and unwinds all passes through `undo()` (undone count equals pass count) instead of assuming a single pass.
- `DocumentModel` → `SurgicalReconciler` (for `computeTextDelta`) would risk a module cycle (`SurgicalReconciler` imports `HTMLDocumentModel`, a `DocumentModel` subclass); avoided by routing the batch through `applyTextUpdate`, which diffs internally — no new import edge beyond leaf modules (`BatchFixer`, `applyEdits`).

## Workload / PR Boundary

- Mode: size:exception (pre-approved for this change; single work unit, no chain slicing — 3.1–3.3 are one cohesive entry+tests unit)
- Current work unit: U3-entry-docs-tests
- Boundary: starts after U2 host/batch-fixer/ports; ends with the engine complete (all 3.x done)
- Changed lines: ~276 (215 new test + ~61 adapter) vs the ~600 guide — within budget; no comments, blank lines, docs, or tests removed to fit.

## Remaining Tasks (out of scope for this unit)

- None — all 3.x tasks complete. Engine work finished; ready for verify.
