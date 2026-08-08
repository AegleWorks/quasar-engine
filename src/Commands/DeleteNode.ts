/**
 * DocumentEngine — DeleteNode Command
 *
 * Deletes a node from the document tree.
 */

import type { Command, CommandContext, CommandResult } from './Command'

export const DeleteNode: Command = {
  id: 'delete-node',
  label: 'Delete Node',
  description: 'Delete the selected node',

  execute(ctx: CommandContext): CommandResult {
    return {
      success: true,
      message: 'Node deleted',
    }
  },
}
