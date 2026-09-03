export type { OptimizationRule, RuleContext, Positioned } from './Rule'
export {
  endOf,
  openRange,
  closeRange,
  positionedChildren,
  hasBothDelimiters,
  deletion,
  coalesceDeletions,
} from './Rule'
export {
  attributeValue,
  normalizeColorValue,
  shortenableHex,
  mergeIdentity,
  MERGEABLE_INLINE,
  BRIDGES_WHITESPACE,
} from './tagValue'
export { MergeAdjacentRule, MERGE_ADJACENT_PRIORITY, type MergeAdjacentOptions } from './mergeAdjacent'
export { DropEmptyTagsRule, DROP_EMPTY_PRIORITY, DROPPABLE_WHEN_EMPTY } from './dropEmptyTags'
export { DropRedundantNestingRule, DROP_REDUNDANT_NESTING_PRIORITY } from './dropRedundantNesting'
export { ShortenHexRule, SHORTEN_HEX_PRIORITY } from './shortenHex'
export {
  UnwrapInvisibleColorRule,
  UNWRAP_INVISIBLE_COLOR_PRIORITY,
  isInvisibleWhitespace,
} from './unwrapInvisibleColor'
export { ReorderWrappersRule, REORDER_WRAPPERS_PRIORITY } from './reorderWrappers'
