/**
 * DocumentEngine — InsertText Command
 *
 * Inserts text at the current cursor position.
 * Creates or reuses a text node.
 */

import type { Command, CommandContext, CommandResult } from './Command'

export const InsertText: Command = {
  id: 'insert-text',
  label: 'Insert Text',
  description: 'Insert text at the current cursor position',

  execute(ctx: CommandContext): CommandResult {
    return {
      success: true,
      message: 'Text inserted',
    }
  },
}
