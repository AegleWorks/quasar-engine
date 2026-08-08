/**
 * DocumentEngine — PluginAPI
 *
 * The public API exposed to plugins.
 * Plugin authors use this to register tags, commands, validators, etc.
 *
 * Inspired by VSCode's `vscode` module.
 */

import { DocumentModel } from '../Model/DocumentModel'
import { TagRegistry, type TagDefinition } from '../Model/TagRegistry'
import { CommandRegistry, type Command } from '../Commands'
import { SemanticAnalyzer, type Validator } from '../Semantic/SemanticAnalyzer'
import { Linter, type LintRule } from '../Linter/Linter'
import { RenderPipeline, type RenderHook } from '../RenderPipeline/RenderPipeline'
import { PluginRegistry, type PluginManifest, type PluginContribution } from './PluginRegistry'

export class PluginAPI {
  readonly model: DocumentModel
  readonly tags: TagRegistry
  readonly commands: CommandRegistry
  readonly semantic: SemanticAnalyzer
  readonly linter: Linter
  readonly renderer: RenderPipeline
  readonly plugins: PluginRegistry

  constructor(model: DocumentModel) {
    this.model = model
    this.tags = model.tagRegistry
    this.commands = new CommandRegistry()
    this.semantic = model.semanticAnalyzer
    this.linter = new Linter()
    this.renderer = new RenderPipeline()
    this.plugins = new PluginRegistry()
  }

  /**
   * Register a plugin with all its contributions.
   *
   * Example:
   * ```ts
   * api.registerPlugin({
   *   name: 'my-plugin',
   *   version: '1.0.0'
   * }, {
   *   tags: [{ name: 'blur', kind: 'custom', ... }],
   *   commands: [{ id: 'my-command', ... }]
   * })
   * ```
   */
  registerPlugin(manifest: PluginManifest, contributions: PluginContribution): void {
    const plugin = this.plugins.register(manifest, contributions)

    // Apply contributions
    if (contributions.tags) {
      for (const tag of contributions.tags) {
        this.tags.register(tag)
      }
    }

    if (contributions.commands) {
      for (const cmd of contributions.commands) {
        this.commands.register(cmd)
      }
    }

    if (contributions.validators) {
      for (const v of contributions.validators) {
        this.semantic.register(v)
      }
    }

    if (contributions.lintRules) {
      for (const rule of contributions.lintRules) {
        this.linter.register(rule)
      }
    }

    if (contributions.renderHooks) {
      for (const hook of contributions.renderHooks) {
        this.renderer.register(hook)
      }
    }

    // Activate
    this.plugins.activate(plugin)
  }

  /**
   * Unregister a plugin and remove its contributions.
   */
  unregisterPlugin(name: string): void {
    const plugin = this.plugins.get(name)
    if (!plugin) return

    if (plugin.contributions.tags) {
      for (const tag of plugin.contributions.tags) {
        this.tags.unregister(tag.name)
      }
    }
    if (plugin.contributions.commands) {
      for (const cmd of plugin.contributions.commands) {
        this.commands.unregister(cmd.id)
      }
    }
    if (plugin.contributions.validators) {
      for (const v of plugin.contributions.validators) {
        this.semantic.unregister(v.code)
      }
    }
    if (plugin.contributions.lintRules) {
      for (const rule of plugin.contributions.lintRules) {
        this.linter.unregister(rule.code)
      }
    }

    this.plugins.unregister(name)
  }
}
