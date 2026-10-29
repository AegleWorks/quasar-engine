/**
 * DocumentEngine — SplitNode & MergeNodes Commands
 *
 * Line-level split and merge: what Enter, Backspace and Delete mean in BBCode.
 * The commands compute the text change; the host applies it.
 */

import type { Command, CommandContext, CommandResult } from './Command'
import { insertLineBreak, joinBackward, joinForward } from './StructuralEdits'

export const SplitNode: Command = {
  id: 'split-node',
  label: 'Split Node',
  description: 'Split the line at the caret (Enter)',

  execute(ctx: CommandContext, input): CommandResult {
    if (!ctx.selection) {
      return { success: false, message: 'split-node needs a selection' }
    }
    if (input && input.type !== 'split') {
      return { success: false, message: 'split-node takes no payload' }
    }
    if (ctx.selection.start !== ctx.selection.end) {
      return { success: false, message: 'split-node needs a collapsed caret' }
    }

    const edit = insertLineBreak(ctx.root, ctx.model.source, {
      start: ctx.selection.start,
      end: ctx.selection.end,
    })
    if (!edit) return { success: false, message: 'Nothing to split' }

    return {
      success: true,
      changes: edit.changes,
      selection: edit.selection,
      message: 'Node split',
    }
  },
}

export const MergeNode: Command = {
  id: 'merge-nodes',
  label: 'Merge Nodes',
  description: 'Join the line at the caret with the previous (or next) one',

  execute(ctx: CommandContext, input): CommandResult {
    if (!ctx.selection) {
      return { success: false, message: 'merge-nodes needs a selection' }
    }
    if (input && input.type !== 'merge') {
      return { success: false, message: 'merge-nodes takes no payload' }
    }

    const direction = input?.type === 'merge' ? input.direction ?? 'backward' : 'backward'
    const selection = { start: ctx.selection.start, end: ctx.selection.end }
    const edit = direction === 'forward'
      ? joinForward(ctx.root, ctx.model.source, selection)
      : joinBackward(ctx.root, ctx.model.source, selection)
    if (!edit) return { success: false, message: 'Nothing to merge' }

    return {
      success: true,
      changes: edit.changes,
      selection: edit.selection,
      // A line with nothing before (or after) it is already joined; say so
      // rather than claim a merge that did not happen.
      message: edit.changes.length === 0 ? 'Nothing to merge' : 'Nodes merged',
    }
  },
}
