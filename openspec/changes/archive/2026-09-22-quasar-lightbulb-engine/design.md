# Design: Quasar Lightbulb Platform

## Technical Approach
Split pure analyzers from fixes: new Fixes/ registries keyed by diagnostic code plus context refactorings. A LightbulbHost queries, ranks (LSP kinds), and previews; BatchFixer applies document-scope Fix-All atomically via transact(). CLI fixSource delegates to BatchFixer; Monaco forwards code+data verbatim.

## Architecture Decisions
| Decision | Options | Tradeoff | Choice |
|---|---|---|---|
| Registry shape | Methods on Analyzer vs standalone registries | Analyzer coupling vs new module | Standalone CodeFixRegistry/RefactoringRegistry in Fixes/; Analyzer emits pure diagnostics |
| Fix atomicity | Per-op vs per-diagnostic accept | Partial repair vs all-or-nothing | Per-diagnostic atomic: FixOperation[] to SurgicalEdit[] via fixToSurgicalEdits; any editsConflict rejects whole fix |
| BatchFixer home | features/ vs quasar Model/ vs CLI | Duplication vs engine ownership | Fixes/BatchFixer.ts in quasar, entry via BBCodeDocumentModel; CLI + collectAutomaticEdits delegate |
| Diagnostic.data | Typed payload vs opaque unknown | Type safety vs Monaco/LSP compat | Opaque data?: unknown, forwarded verbatim publish to codeAction to provider |
| Ranking/kinds | Ad-hoc flags vs LSP kinds | Custom UI vs interop | LSP kinds: quickfix, refactor.extract/rewrite, source.fixAll; auto vs manual via isAutomatic |
| Collab batch | Direct transact vs CollabSession.applyEdits | Bypasses Yjs ownership/undo tracking | All batches via CollabSession.applyEdits (DESC sort, ownership guard); direct transact only when no session |

## Data Flow
analyze() to Diagnostic{code,range,data} -> LightbulbHost.query(range/offset): CodeFixRegistry.get(code) to FixOperation[] preview via applyEditsToSource; RefactoringRegistry.match(RedNode+offset) preview without mutation. BatchFixer.fixAll(docs, equivalenceKey): filter, sort DESC, overlap reject, transact(), rebuild, re-analyze (multipass <=10 + cycle detect). Monaco: publishDiagnostics(code+data) round-trips verbatim into codeAction resolve.

## File Changes
| File | Action | Description |
|---|---|---|
| quasar/src/Types/diagnostics.ts | Modify | Add data?: unknown, equivalenceKey?: string, CodeActionKind |
| quasar/src/Fixes/CodeFixRegistry.ts | Create | register(code,provider), get(code); provider returns FixOperation[] |
| quasar/src/Fixes/RefactoringRegistry.ts | Create | match(node,offset,source) context providers + preview |
| quasar/src/Fixes/LightbulbHost.ts | Create | Ranked query, kind mapping, preview, Fix-All candidate (source.fixAll) |
| quasar/src/Fixes/BatchFixer.ts | Create | Document scope; equivalenceKey filter, DESC sort, overlap reject, <=10 passes, cycle warn; project scope stub throws |
| quasar/src/Fixes/refactorings/combineBolds.ts | Create | Example 1: merge adjacent bolds |
| quasar/src/Fixes/refactorings/extractTemplate.ts | Create | Example 2: selection to template |
| quasar/src/Semantic/*validators* | Modify | Strip embedded fixes; emit code+data only |
| quasar/src/Linter/Linter.ts | Modify | Rule-by-rule: 4 closures to Fix providers; legacy flag until green |
| quasar/src/Plugins/{PluginAPI,PluginRegistry}.ts | Modify | codeFixes/refactorings contributions + unregister |
| quasar/src/Model/DocumentModel.ts | Modify | BatchFixer entry docs; no transact change |
_Parent integration (CLI, features, collab, Monaco) lives in miliastry change quasar-lightbulb-platform._

## Interfaces / Contracts
CodeFixProvider = (diag, {source, node}) => FixOperation[]; RefactoringProvider = {id, title, kinds, match(n,off,src): boolean, edits(n,off,src): SurgicalEdit[]}; BatchResult = {applied, deferred, passes, cycle?}; FixAllScope = 'document' ('project'/'solution' stub throws Unimplemented). RefactorAll: stub only.

## Testing Strategy
| Layer | What | Approach |
|---|---|---|
| Unit | Registry miss, atomic reject, edge-touch allow, data round-trip | DiagnosticFixes, EditConflicts extensions |
| Integration | Document Fix-All, multipass <=10, cycle warn, Linter parity (4 rules) | Quasar model tests + CLI diagnostics.test |

## Threat Matrix
N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout
Rule-by-rule Linter port with legacy-closure flag; single commit revert restores collectAutomaticEdits. Submodule sync: pin abb4965, run quasar CI before host publish. i18n: engine emits fixed English description; app translates by code, unknown codes fall back to engine text.

## Open Questions
- [ ] Dual-kind (quickfix+fixAll) in one action or two entries?
- [ ] equivalenceKey derivation per rule — explicit field or provider function?
