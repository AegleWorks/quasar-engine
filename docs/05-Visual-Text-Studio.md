# 5. Visual Text Studio (`Transformers/` & `Studio/`)

Efectos visuales avanzados y dinámicos aplicados directamente sobre el AST.

## Transformers
- **`ASTOptimizer`**: Reglas de optimización *Fixpoint* (fusiona tags idénticos adyacentes, fuerza el ordenamiento canónico para evitar fragmentación innecesaria).
- **`GradientTransformer`**: Convierte bloques de texto en nodos de color interpolados caracter por caracter.
- **`GrowTransformer`**: Oscila los tamaños de fuente a través del texto (usando una onda senoidal).
- **`RainbowTransformer`**: Hace un ciclo de tonos HSL a través de los caracteres.
- **`SineWaveTransformer`**: Aplica offsets posicionales en forma de onda senoidal a los caracteres (efecto de movimiento ondulado).

## Studio
- **`StudioEffects`**: Lógica visual núcleo del TextStudio. Convierte segmentos simples de texto en árboles de efectos complejos mediante manipulación directa y segura del AST.
- **`StudioColorMath`**: Matemática avanzada para espacios de color, específica para el motor visual.
- **`StudioFonts`**: Lógica base para manejar métricas, escalados y tamaños de fuentes.
