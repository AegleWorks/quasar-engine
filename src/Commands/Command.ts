/**
 * DocumentEngine — Command
 *
 * Commands are high-level user actions that MAY produce
 * a Transaction (or multiple) to modify the document.
 *
 * Commands are stateless — they receive context and produce operations.
 * This makes them testable, undoable, and safe for AI use.
 *
 * Inspired by ProseMirror's Commands and VSCode's Command system.
 */

import { DocumentModel } from '../Model/DocumentModel'
import type { Operation } from '../Types/operations'
import type { RedNode } from '../Syntax/RedNode'

export interface CommandContext {
  model: DocumentModel
  root: RedNode
  selection?: {
    nodeId: string
    start: number
    end: number
  }
}

export type CommandResult = {
  success: boolean
  operations?: Operation[]
  message?: string
}

export interface Command {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly shortcut?: string
  execute(ctx: CommandContext): CommandResult
  canExecute?(ctx: CommandContext): boolean
}

export function canExecute(command: Command, ctx: CommandContext): boolean {
  return command.canExecute?.(ctx) ?? true
}
