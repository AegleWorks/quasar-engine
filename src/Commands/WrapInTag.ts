/**
 * DocumentEngine — WrapInTag Command
 *
 * Wraps the selection in an inline BBCode tag: b/i/u/s toggle, every other
 * inline tag is applied verbatim. Block tags are refused — they are content
 * to insert, not a wrapper around a selection.
 */

import type { Command, CommandContext, CommandResult } from './Command'
import { toggleInlineFormat, wrapInTag, type ToggleFormat } from './InlineFormat'
import { isBlockKind, tagToNodeKind } from '../BBCode/BBCodeToGreenNode'

const TOGGLE: Readonly<Record<string, ToggleFormat>> = {
  b: 'bold',
  i: 'italic',
  u: 'underline',
  s: 'strikethrough',
}

export const WrapInTag: Command = {
  id: 'wrap-in-tag',
  label: 'Wrap in Tag',
  description: 'Wrap the selection in an inline BBCode tag; b/i/u/s toggle',

  execute(ctx: CommandContext, input): CommandResult {
    if (!ctx.selection) {
      return { success: false, message: 'wrap-in-tag needs a selection' }
    }
    if (input?.type !== 'wrap') {
      return { success: false, message: 'wrap-in-tag needs { type: "wrap", tag }' }
    }

    const tag = input.tag.toLowerCase()
    if (!/^[a-z][a-z0-9]*$/.test(tag)) {
      return { success: false, message: `Invalid tag: ${input.tag}` }
    }
    if (isBlockKind(tagToNodeKind(tag))) {
      return { success: false, message: `[${tag}] is block content; insert it with insert-text` }
    }

    const format = TOGGLE[tag]
    if (format && input.attrs !== undefined && input.attrs !== '') {
      return { success: false, message: `[${tag}] does not take attributes` }
    }

    const start = Math.min(ctx.selection.start, ctx.selection.end)
    const end = Math.max(ctx.selection.start, ctx.selection.end)
    const edit = format
      ? toggleInlineFormat(ctx.root, ctx.model.source, { start, end }, format)
      : wrapInTag(ctx.root, ctx.model.source, { start, end }, tag, input.attrs)
    if (!edit) return { success: false, message: 'Nothing to wrap' }

    return {
      success: true,
      changes: edit.changes,
      selection: edit.selection,
      message: format ? 'Format toggled' : `Wrapped in [${tag}]`,
    }
  },
}
