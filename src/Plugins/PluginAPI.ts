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
  /**
   * The `<style>` elements this API injected per plugin, so unregistering can
   * remove exactly its own. A plugin that ships CSS in two registrations would
   * otherwise leave the first copy in the document forever.
   */
  private readonly styleElements = new Map<string, HTMLStyleElement[]>()

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
    // Dependencies are a promise the manifest makes, so a missing one is a
    // registration error, not a warning nobody reads until the tag fails to
    // render. Callers register dependencies first (there is no filesystem to
    // resolve them from); a cycle would already violate that order.
    const missing = (manifest.dependencies ?? []).filter(
      dependency => dependency !== manifest.name && this.plugins.get(dependency) === undefined,
    )
    if (missing.length > 0) {
      throw new Error(
        `[PluginAPI] "${manifest.name}" requires ${missing.map(name => `"${name}"`).join(', ')} — register the dependency first`,
      )
    }

    // A second registration under the same name replaces the first: take the
    // first one's contributions back before adding the new ones, or they stay
    // installed with nothing left to remove them.
    if (this.plugins.get(manifest.name)) this.unregisterPlugin(manifest.name)
    const plugin = this.plugins.register(manifest, contributions)

    // The manifest declares CSS as part of the contribution; inject it here so
    // a browser consumer does not have to know plugin internals. Headless
    // engines (Node, SSR, a worker) simply have no document to inject into.
    if (contributions.styles?.length) {
      this.injectStyles(manifest.name, contributions.styles)
    }

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

    this.removeStyles(name)

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

  // ── Styles ─────────────────────────────────────────────────────

  private injectStyles(name: string, styles: readonly string[]): void {
    this.removeStyles(name)
    if (typeof document === 'undefined') return

    const elements = styles.map(css => {
      const element = document.createElement('style')
      element.setAttribute('data-quasar-plugin', name)
      element.textContent = css
      document.head.appendChild(element)
      return element
    })
    this.styleElements.set(name, elements)
  }

  private removeStyles(name: string): void {
    const elements = this.styleElements.get(name)
    if (elements === undefined) return
    for (const element of elements) element.remove()
    this.styleElements.delete(name)
  }
}
