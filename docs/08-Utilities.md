# 8. Utilities (`Utils/`)

Funciones independientes, matemáticas y herramientas de soporte que asisten al motor en tareas específicas.

- **`color`**: Funciones matemáticas puras (sin estado) para parseo e interpolación hexadecimal (`hslToHex`, `mixHex`).
- **`treeTransformers`**: Wrappers de alto nivel para aplicar, de forma segura y estructurada, efectos del Studio a través de todo un árbol `RedNode`.
- **`BBCodeGenerator`**: Generación procedural de BBCode (con estilo osu!) para propósitos de mocking, benchmarking y testing masivo automatizado.
- **`dom-to-svg`**: Lógica de alta fidelidad para capturar layouts y nodos generados en el DOM hacia formato SVG.
