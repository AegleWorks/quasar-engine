/**
 * DocumentEngine — DeleteNode Command
 *
 * Deletes a node (by `nodeId`) or the selected range, as one text change that
 * keeps every tag the deletion cuts through.
 */

import type { Command, CommandContext, CommandResult } from './Command'
import type { NodeId } from '../Types/core'
import { deleteSelection } from './StructuralEdits'

export const DeleteNode: Command = {
  id: 'delete-node',
  label: 'Delete Node',
  description: 'Delete the selected node, or the selected range',

  execute(ctx: CommandContext, input): CommandResult {
    if (!ctx.selection) {
      return { success: false, message: 'delete-node needs a selection' }
    }
    if (input && input.type !== 'delete') {
      return { success: false, message: 'delete-node takes no payload' }
    }

    let start = Math.min(ctx.selection.start, ctx.selection.end)
    let end = Math.max(ctx.selection.start, ctx.selection.end)

    if (start === end) {
      if (!ctx.selection.nodeId) {
        return { success: false, message: 'delete-node needs a nodeId or a range' }
      }
      // `nodeId` is whatever the host kept (a DOM attribute, a map key); the
      // tree only uses it for comparison, so the brand is a formality here.
      const node = ctx.root.findById(ctx.selection.nodeId as NodeId)
      if (!node) return { success: false, message: `Node not found: ${ctx.selection.nodeId}` }
      if (node === ctx.root) return { success: false, message: 'The root cannot be deleted' }
      start = node.range.start
      end = node.range.end
    }

    const edit = deleteSelection(ctx.root, ctx.model.source, { start, end })
    if (!edit) return { success: false, message: 'Nothing to delete' }

    return {
      success: true,
      changes: edit.changes,
      selection: edit.selection,
      message: 'Node deleted',
    }
  },
}
