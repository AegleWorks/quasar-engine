/**
 * DocumentEngine — Command
 *
 * A command is a PLANNER for a high-level user action: it reads the tree and
 * the source selection and returns the text changes that make the edit (or a
 * Transaction's operations, for commands that need one). It does not apply
 * anything, so the same command works under Monaco's single undo stop, the
 * canvas' surgical edits, a preview, or a test.
 *
 * Commands are stateless — they receive context and produce a result. That
 * makes them testable, undoable, and safe for AI use.
 *
 * Inspired by ProseMirror's Commands and VSCode's Command system.
 */

import type { DocumentModel } from '../Model/DocumentModel'
import type { Operation } from '../Types/operations'
import type { RedNode } from '../Syntax/RedNode'
import type { TextChange } from '../Incremental/ChangeTracker'
import type { SourceSelection } from './InlineFormat'

export interface CommandContext {
  model: DocumentModel
  root: RedNode
  selection?: {
    /** Node the selection starts in, when the host has one. */
    nodeId?: string
    /** Offsets in `model.source`. */
    start: number
    end: number
  }
}

/**
 * The payload a command needs, discriminated by family.
 *
 * A command that does not need one (`delete`, `split`) ignores it; one that
 * does (`insertText`, `wrap`) refuses a payload of the wrong shape instead of
 * guessing what the caller meant.
 */
export type CommandInput =
  | { type: 'insertText'; text: string }
  | { type: 'wrap'; tag: string; attrs?: string }
  | { type: 'delete' }
  | { type: 'split' }
  | { type: 'merge'; direction?: 'backward' | 'forward' }

export type CommandResult = {
  success: boolean
  /** Tree operations, for commands that edit through `transact`. */
  operations?: Operation[]
  /**
   * Text changes in the coordinates of `ctx.model.source`, for the host to
   * apply as one edit. A command computes them and never mutates the model.
   */
  changes?: TextChange[]
  /** Where the selection lands after `changes`, when the command can say. */
  selection?: SourceSelection
  message?: string
}

export interface Command {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly shortcut?: string
  execute(ctx: CommandContext, input?: CommandInput): CommandResult
  canExecute?(ctx: CommandContext): boolean
}

export function canExecute(command: Command, ctx: CommandContext): boolean {
  return command.canExecute?.(ctx) ?? true
}
