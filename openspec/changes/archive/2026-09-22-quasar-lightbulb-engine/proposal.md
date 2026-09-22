# Proposal: Quasar Lightbulb Engine

## Intent
Quasar couples diagnostics to fixes and lacks refactorings, Fix-All, and LSP round-trip. Build the Roslyn-type engine side: pure analyzers, unified fix operations, context refactorings, lightbulb host, and safe batch application. Parent integration (CLI, features, collab, Monaco) is a separate change.

## Scope
### In Scope
- Split CodeFixProvider / RefactoringProvider from SemanticAnalyzer validators
- Unify all fixes to atomic FixOperation[]; migrate 4 Linter closure rules
- Lightbulb host with LSP kinds (quickfix, refactor.*, source.fixAll) + preview
- BatchFixer document scope + equivalenceKey; project scope stubbed
- Opaque Diagnostic.data preserved end to end
- 1-2 example refactorings (combine bolds, extract template)
- Bounded multipass (<=10) with circular-fix detection
### Out of Scope
- Parent integration: CLI delegate, features translation, Monaco provider, CollabSession guard (separate change)
- Project/solution cross-document Fix-All (stub only)
- RefactorAll batch path (deferred)
- New analyzer rules beyond migration needs

## Capabilities
### New Capabilities
- `code-fixes`: pure CodeFixProvider registry keyed by diagnostic code
- `code-refactorings`: context-triggered providers with preview
- `fix-all`: BatchFixer document scope with equivalenceKey
- `lightbulb-host`: ranked quickfix/refactor/source.fixAll resolution
### Modified Capabilities
- `diagnostics`: add opaque data field, stable codes, kind mapping
- `linter-rules`: closure fixes migrated to FixOperation[]

## Approach
Standalone Fixes/ registries; LightbulbHost queries, ranks, previews; BatchFixer applies via transact(); CLI/parent delegate. Refactorings resolve from RedNode+offset, preview via applyEditsToSource.

## Affected Areas
| Area | Impact | Description |
|------|--------|-------------|
| `src/Semantic/` | Modified | Validator/fix split, provider registries |
| `src/Types/diagnostics.ts` | Modified | data field, kinds |
| `src/Linter/` | Modified | Closure to FixOperation migration |
| `src/Fixes/` | New | Registries, host, BatchFixer, example refactorings |
| `src/Model/DocumentModel.ts` | Modified | BatchFixer entry docs; no transact change |
| `src/Plugins/` | Modified | codeFixes/refactorings contributions |

## Risks
| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Linter migration breakage | Med | Rule-by-rule port + existing tests |
| Collab contract mismatch | Med | BatchFixer honors applyEdits ordering upstream |
| Scope exceeds review budget | High | size:exception approved; sliceable units U1-U3 |

## Rollback Plan
Revert provider registrations to validator-coupled path; keep legacy Linter closures behind flag until migration passes.

## Dependencies
- Quasar repo CI green before publish
- Parent change consumes the published engine + bumps pointer

## Success Criteria
- [ ] All fixes pure FixOperation[]; no closure fixes remain
- [ ] Lightbulb returns ranked fixes+refactorings with preview
- [ ] Document Fix-All applies safely with overlap rejection
- [ ] Multipass terminates with cycle warning
- [ ] code+data survive the engine round-trip
