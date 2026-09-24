export {
  classifyOverlap,
  editsConflict,
  compareEditPriority,
  resolveEditConflicts,
} from './EditPlan'
export type {
  PlannedEdit,
  RejectedEdit,
  ResolvedEditPlan,
  EditRejectionReason,
  OverlapRelation,
} from './EditPlan'
export { applyEditsToSource } from './applyEdits'
export { composeEditPasses } from './composeEdits'
export { fixToSurgicalEdits } from './fixEdits'
export {
  optimizeBBCode,
  optimizeBBCodeFully,
  optimizeTree,
  defaultRules,
  allRules,
} from './Optimizer'
export type { FixpointOptimizationResult, OptimizationResult, OptimizeOptions, RuleStat } from './Optimizer'
export * from './Rules'
