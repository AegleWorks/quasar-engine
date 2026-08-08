import { RedNode } from '../Syntax/RedNode'
import { Visitor } from './Visitor'
import { HTMLRenderer } from './HTMLRenderer'
import type { VisitorContext } from './Visitor'

/**
 * SVGRenderer (Runtime ForeignObject Strategy)
 * 
 * Instead of attempting to calculate CSS layouts manually,
 * this runtime renderer wraps the exact HTML output in an SVG <foreignObject>.
 * 
 * This gives 100% precision with zero DOM scanning overhead for real-time previews.
 */
export class SVGRenderer extends Visitor<string> {
  private htmlRenderer = new HTMLRenderer()

  visit(node: RedNode, context?: VisitorContext): string {
    if (context) this.context = context
    return this.render(node)
  }

  render(root: RedNode): string {
    const htmlContent = this.htmlRenderer.render(root)
    
    // We wrap the HTML in a foreignObject. The container gets the standard BBCode preview classes
    // so it inherits all global CSS (osu.css, tailwind, etc.) perfectly.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" class="bb-preview bbcode-preview text-sm leading-relaxed text-[#E8E0E4] wrap-break-word min-w-0 w-full h-full p-4 box-border">
      ${htmlContent}
    </div>
  </foreignObject>
</svg>`
  }
}
