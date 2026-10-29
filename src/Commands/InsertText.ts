/**
 * DocumentEngine — InsertText Command
 *
 * Inserts text (plain or BBCode) at the selection, as one text change. The
 * host applies it; the model is not touched.
 */

import type { Command, CommandContext, CommandResult } from './Command'
import { insertContent } from './InsertContent'

export const InsertText: Command = {
  id: 'insert-text',
  label: 'Insert Text',
  description: 'Insert text or BBCode at the selection',

  execute(ctx: CommandContext, input): CommandResult {
    if (!ctx.selection) {
      return { success: false, message: 'insert-text needs a selection' }
    }
    if (input?.type !== 'insertText') {
      return { success: false, message: 'insert-text needs { type: "insertText", text }' }
    }

    const start = Math.min(ctx.selection.start, ctx.selection.end)
    const end = Math.max(ctx.selection.start, ctx.selection.end)
    const edit = insertContent(
      ctx.root,
      ctx.model.source,
      { start, end },
      input.text,
      (source) => ctx.model.parseSource(source),
    )
    if (!edit) return { success: false, message: 'Nothing to insert' }

    return {
      success: true,
      changes: edit.changes,
      selection: edit.selection,
      message: 'Text inserted',
    }
  },
}
