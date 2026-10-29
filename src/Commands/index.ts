import { CommandRegistry } from './CommandRegistry'
import { InsertText } from './InsertText'
import { DeleteNode } from './DeleteNode'
import { WrapInTag } from './WrapInTag'
import { SplitNode, MergeNode } from './SplitMerge'

export { CommandRegistry } from './CommandRegistry'
export type { Command, CommandContext, CommandResult, CommandInput } from './Command'
export { InsertText } from './InsertText'
export { DeleteNode } from './DeleteNode'
export { WrapInTag } from './WrapInTag'
export { SplitNode, MergeNode } from './SplitMerge'

/** Every command this package ships. */
export const BUILTIN_COMMANDS = [InsertText, DeleteNode, WrapInTag, SplitNode, MergeNode] as const

/**
 * A registry with the built-in commands already registered.
 *
 * `new CommandRegistry()` is still the empty extension point a plugin or a
 * host starts from; this is the convenient default so the five commands are
 * usable without every host having to remember their names.
 */
export function createCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry()
  for (const command of BUILTIN_COMMANDS) registry.register(command)
  return registry
}
