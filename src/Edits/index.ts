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
export {
  optimizeBBCode,
  optimizeTree,
  defaultRules,
  allRules,
} from './Optimizer'
export type { OptimizationResult, OptimizeOptions, RuleStat } from './Optimizer'
export * from './Rules'
