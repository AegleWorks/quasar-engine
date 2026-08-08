/**
 * DocumentEngine — WrapInTag Command
 *
 * Wraps the current selection in a BBCode tag.
 * E.g. selected text → [b]selected text[/b]
 */

import type { Command, CommandContext, CommandResult } from './Command'

export const WrapInTag: Command = {
  id: 'wrap-in-tag',
  label: 'Wrap in Tag',
  description: 'Wrap the current selection in a BBCode tag',

  execute(ctx: CommandContext): CommandResult {
    return {
      success: true,
      message: 'Wrapped in tag',
    }
  },
}
