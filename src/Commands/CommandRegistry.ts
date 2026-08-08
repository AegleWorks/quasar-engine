/**
 * DocumentEngine — CommandRegistry
 *
 * Central registry for all document commands.
 * Commands can be added by plugins.
 *
 * Enables:
 * - Keyboard shortcut binding
 * - Toolbar integration
 * - AI command execution
 * - Menu integration
 */

import type { Command, CommandContext, CommandResult } from './Command'

export class CommandRegistry {
  private commands: Map<string, Command> = new Map()

  /**
   * Register a command.
   */
  register(command: Command): void {
    this.commands.set(command.id, command)
  }

  /**
   * Unregister a command.
   */
  unregister(id: string): void {
    this.commands.delete(id)
  }

  /**
   * Get a command by ID.
   */
  get(id: string): Command | undefined {
    return this.commands.get(id)
  }

  /**
   * Check if a command is registered.
   */
  has(id: string): boolean {
    return this.commands.has(id)
  }

  /**
   * Execute a command by ID.
   */
  execute(id: string, ctx: CommandContext): CommandResult {
    const command = this.commands.get(id)
    if (!command) {
      return { success: false, message: `Unknown command: ${id}` }
    }
    return command.execute(ctx)
  }

  /**
   * Get all registered commands.
   */
  getAll(): Command[] {
    return Array.from(this.commands.values())
  }

  /**
   * Get commands by a filter function.
   */
  filter(predicate: (cmd: Command) => boolean): Command[] {
    return this.getAll().filter(predicate)
  }

  /**
   * Get the count of registered commands.
   */
  get size(): number {
    return this.commands.size
  }
}
