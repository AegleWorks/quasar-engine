/**
 * DocumentEngine — PluginRegistry
 *
 * Manages the lifecycle of plugins/extensions.
 * Each plugin registers contributions (tags, commands, validators, etc.)
 * and can be loaded/unloaded at runtime.
 *
 * Inspired by VSCode's extension system.
 */

import type { TagDefinition } from '../Model/TagRegistry'
import type { Command } from '../Commands/Command'
import type { Validator } from '../Semantic/SemanticAnalyzer'
import type { LintRule } from '../Linter/Linter'
import type { RenderHook } from '../RenderPipeline/RenderPipeline'

export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  /** Dependencies on other plugins */
  dependencies?: string[]
}

export interface PluginContribution {
  /** Tags to register */
  tags?: TagDefinition[]
  /** Commands to register */
  commands?: Command[]
  /** Semantic validators */
  validators?: Validator[]
  /** Lint rules */
  lintRules?: LintRule[]
  /** Render hooks */
  renderHooks?: RenderHook[]
  /** CSS to inject */
  styles?: string[]
  /** Initialization function */
  activate?: () => void | Promise<void>
  /** Cleanup function */
  deactivate?: () => void
}

export interface Plugin {
  manifest: PluginManifest
  contributions: PluginContribution
  /** Whether the plugin is currently active */
  active: boolean
}

export class PluginRegistry {
  private plugins: Map<string, Plugin> = new Map()

  /**
   * Register a plugin.
   */
  register(manifest: PluginManifest, contributions: PluginContribution): Plugin {
    const plugin: Plugin = { manifest, contributions, active: false }
    this.plugins.set(manifest.name, plugin)
    return plugin
  }

  /**
   * Unregister and deactivate a plugin.
   */
  unregister(name: string): boolean {
    const plugin = this.plugins.get(name)
    if (!plugin) return false
    this.deactivate(plugin)
    this.plugins.delete(name)
    return true
  }

  /**
   * Get a plugin by name.
   */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name)
  }

  /**
   * Get all registered plugins.
   */
  getAll(): Plugin[] {
    return Array.from(this.plugins.values())
  }

  /**
   * Activate a plugin (calls activate function).
   */
  activate(plugin: Plugin): void {
    if (plugin.active) return
    try {
      plugin.contributions.activate?.()
      plugin.active = true
    } catch (error) {
      console.warn(`[PluginRegistry] Failed to activate plugin "${plugin.manifest.name}":`, error)
    }
  }

  /**
   * Deactivate a plugin (calls deactivate function).
   */
  deactivate(plugin: Plugin): void {
    if (!plugin.active) return
    try {
      plugin.contributions.deactivate?.()
      plugin.active = false
    } catch (error) {
      console.warn(`[PluginRegistry] Failed to deactivate plugin "${plugin.manifest.name}":`, error)
    }
  }

  /**
   * Activate all registered plugins.
   */
  activateAll(): void {
    for (const [, plugin] of this.plugins) {
      this.activate(plugin)
    }
  }

  /**
   * Deactivate all plugins.
   */
  deactivateAll(): void {
    for (const [, plugin] of this.plugins) {
      this.deactivate(plugin)
    }
  }
}
