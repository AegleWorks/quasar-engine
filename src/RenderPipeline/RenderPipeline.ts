/**
 * DocumentEngine — RenderPipeline
 *
 * The Render Pipeline transforms a DocumentModel into renderable output.
 * It sits between the model and the view layer.
 *
 * The pipeline is:
 *   DocumentModel → RenderTree → HTML/SVG/Canvas/React
 *
 * Plugins can intercept at any stage:
 * - Add/transform render nodes
 * - Provide custom renderers for custom tags
 * - Post-process the output
 */

import { RedNode } from '../Syntax/RedNode'
import { RenderTree, type RenderNode, type RenderVariant } from './RenderTree'
import type { TagRegistry, TagHandlerContext } from '../Model/TagRegistry'

export type RenderPhase =
  | 'build'      // DocumentModel → RenderNode tree
  | 'transform'  // Plugin transforms
  | 'serialize'  // RenderNode → Output string

export interface RenderHook {
  phase: RenderPhase
  hook: (node: RenderNode, context: RenderContext) => RenderNode | null
}

export interface RenderContext {
  variant: RenderVariant
  registry: TagRegistry
  source: string
}

export class RenderPipeline {
  private hooks: RenderHook[] = []

  /**
   * Register a render hook.
   */
  register(hook: RenderHook): void {
    this.hooks.push(hook)
  }

  /**
   * Unregister a render hook.
   */
  unregister(hook: RenderHook): void {
    const idx = this.hooks.indexOf(hook)
    if (idx >= 0) this.hooks.splice(idx, 1)
  }

  /**
   * Render a RedNode tree to a string.
   */
  render(
    root: RedNode,
    variant: RenderVariant = 'html',
    registry: TagRegistry,
    source: string = '',
  ): string {
    const context: RenderContext = { variant, registry, source }

    // Phase 1: Build render tree
    let renderTree = this.buildRenderTree(root, context)

    // Phase 2: Apply transformations
    for (const hook of this.hooks) {
      if (hook.phase === 'transform') {
        renderTree = hook.hook(renderTree, context) ?? renderTree
      }
    }

    // Phase 3: Serialize
    for (const hook of this.hooks) {
      if (hook.phase === 'serialize') {
        const result = hook.hook(renderTree, context)
        if (result) return result.text
      }
    }

    // Default serialization
    return RenderTree.toHTML(renderTree)
  }

  /**
   * Build a RenderNode tree from a RedNode tree.
   */
  private buildRenderTree(node: RedNode, context: RenderContext): RenderNode {
    // Text nodes
    if (node.kind === 'text') {
      return RenderTree.text(node.text)
    }

    // Document root
    if (node.kind === 'document') {
      const children = node.children.map(c => this.buildRenderTree(c, context))
      return RenderTree.container('document', children)
    }

    // Check tag registry for custom render handlers
    const tagDef = context.registry.getByKind(node.kind)
    if (tagDef?.toRenderNode) {
      return tagDef.toRenderNode({
        node,
        source: context.source,
        visitChildren: (n) => {
          const r = this.buildRenderTree(n, context)
          return RenderTree.toHTML(r)
        },
        renderChild: (n) => this.buildRenderTree(n, context),
      })
    }

    // Default rendering
    const children = node.children.map(c => this.buildRenderTree(c, context))
    const kind = node.kind

    return RenderTree.container(kind, children, {
      tag: node.metadata?.tagName,
      ...node.metadata,
    })
  }
}
