# 4. Render Pipeline & Exporters (`RenderPipeline/` & `Visitors/`)

Pipelines transforming the Abstract Syntax Tree into target output formats.

## `RenderPipeline` & `RenderTree`
- **`RenderPipeline`**: High-level coordinator that validates syntax nodes, applies registered transformation passes, and builds a normalized `RenderTree`.
- **`RenderTree`**: An intermediate representation optimized purely for layout and rendering, abstracting away BBCode parsing quirks.

## `Visitors`
Abstract base class for AST traversal, implemented by:
- **`HTMLRenderer`**: Compiles the *Red Tree* into standards-compliant HTML. Includes an emulation mode replicating legacy rendering behaviors of official osu! web pages.
- **`DOMMorpher`**: Performs in-place DOM diffing and patching on `HTMLRenderer` output, achieving high-performance UI updates while preserving active media playback, details toggles, and scroll state.

## Exporters
- **`BBCodeExporter`**: Serializes the *Red Tree* back into standard or expanded BBCode strings.
- **`MarkdownExporter`**: Converts the *Red Tree* into structured Markdown.
- **`TiptapExporter`**: Maps Quasar's AST into ProseMirror/Tiptap JSON schema for rich web WYSIWYG editor integration.
- **`JSONExporter`**: Serializes the *Red Tree* into canonical structured JSON.
- **`SVGRenderer`**: Wraps HTML output inside `<foreignObject>` elements for native vector graphic export.
