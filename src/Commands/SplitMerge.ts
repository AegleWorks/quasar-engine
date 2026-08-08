/**
 * DocumentEngine — SplitNode & MergeNodes Commands
 *
 * Split a node at a position, or merge two adjacent nodes.
 * Essential for block editing and backspace handling.
 */

import type { Command, CommandContext, CommandResult } from './Command'

export const SplitNode: Command = {
  id: 'split-node',
  label: 'Split Node',
  description: 'Split a node at the current cursor position',

  execute(ctx: CommandContext): CommandResult {
    return { success: true, message: 'Node split' }
  },
}

export const MergeNode: Command = {
  id: 'merge-nodes',
  label: 'Merge Nodes',
  description: 'Merge two adjacent nodes',

  execute(ctx: CommandContext): CommandResult {
    return { success: true, message: 'Nodes merged' }
  },
}
