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
import { registerCodeFix } from '../Fixes/CodeFixRegistry'
import { registerRefactoring, unregisterRefactoring } from '../Fixes/RefactoringRegistry'
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
  /**
   * What each plugin's code fixes put in the registry, by plugin name: the
   * functions that take back exactly those registrations. Unregistering used
   * to delete the CODE, taking the built-in (or another plugin's override of
   * the same code) with it.
   */
  private readonly codeFixDisposers = new Map<string, (() => void)[]>()

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
    // A second registration under the same name replaces the first: take the
    // first one's contributions back before adding the new ones, or they stay
    // installed with nothing left to remove them.
    if (this.plugins.get(manifest.name)) this.unregisterPlugin(manifest.name)
    const plugin = this.plugins.register(manifest, contributions)
    // Declared in the types, honoured nowhere yet: say so instead of
    // pretending the CSS was injected or the dependency checked.
    if (contributions.styles?.length) console.warn(`[PluginAPI] "${manifest.name}": styles are not injected by the engine; load them yourself`)
    if (manifest.dependencies?.length) console.warn(`[PluginAPI] "${manifest.name}": dependencies are not checked by the engine`)

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

    if (contributions.codeFixes) {
      this.codeFixDisposers.set(
        manifest.name,
        contributions.codeFixes.map((fix) => registerCodeFix(fix.code, fix.provider, fix.meta)),
      )
    }

    if (contributions.refactorings) {
      for (const refactoring of contributions.refactorings) {
        registerRefactoring(refactoring)
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
    for (const dispose of this.codeFixDisposers.get(name) ?? []) dispose()
    this.codeFixDisposers.delete(name)
    if (plugin.contributions.refactorings) {
      for (const refactoring of plugin.contributions.refactorings) {
        unregisterRefactoring(refactoring.id)
      }
    }
    if (plugin.contributions.renderHooks) {
      for (const hook of plugin.contributions.renderHooks) {
        this.renderer.unregister(hook)
      }
    }

    this.plugins.unregister(name)
  }
}
