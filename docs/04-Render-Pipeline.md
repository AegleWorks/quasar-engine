# 4. Render Pipeline & Exporters (`RenderPipeline/` & `Visitors/`)

Sistemas que transforman el AST a sus formatos de salida finales.

## `RenderPipeline` & `RenderTree`
- **`RenderPipeline`**: Coordinador de alto nivel. Valida los nodos, aplica transformaciones y construye un `RenderTree` normalizado.
- **`RenderTree`**: Una representación intermedia optimizada puramente para el renderizado, abstrayendo las particularidades y "quirks" del parseo de BBCode.

## `Visitors`
Clase abstracta base para recorrer el AST, implementada por:
- **`HTMLRenderer`**: Transforma el *Red Tree* a HTML nativo. Incluye un modo (toggle) para replicar exactamente los comportamientos heredados del BBCode de osu! web.
- **`DOMMorpher`**: Diffeo y parcheo en el lugar (in-place) para los resultados del `HTMLRenderer`, logrando actualizaciones de UI extremadamente performantes al mantener vivos los estados de los elementos activos en el DOM del navegador.

## Exporters
- **`BBCodeExporter`**: Serializa el *Red Tree* de regreso a texto BBCode estándar.
- **`MarkdownExporter`**: Convierte el *Red Tree* a formato Markdown.
- **`TiptapExporter`**: Conecta el AST de Quasar al formato JSON de ProseMirror/Tiptap, facilitando la integración con editores WYSIWYG de la web moderna.
- **`JSONExporter`**: Serializa el *Red Tree* a JSON estructurado.
- **`SVGRenderer`**: Envuelve la salida HTML en un `<foreignObject>` para permitir exportación vectorial nativa.
