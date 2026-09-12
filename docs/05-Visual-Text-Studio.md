# 5. Visual Text Studio (`Transformers/` & `Studio/`)

Advanced and dynamic visual effects applied directly over the AST.

## Transformers
- **`ASTOptimizer`**: Fixpoint optimization rules (coalescing adjacent identical tags, enforcing canonical tag ordering to eliminate fragmentation).
- **`GradientTransformer`**: Interpolates multi-stop color ramps across text runs on a per-character basis.
- **`GrowTransformer`**: Modulates font sizes across text using sinusoidal wave curves.
- **`RainbowTransformer`**: Cycles HSL hue angles across character sequences.
- **`SineWaveTransformer`**: Applies vertical baseline positional offsets in a sine wave pattern.

## Studio
- **`StudioEffects`**: Core visual engine behind TextStudio. Compiles declarative effect configurations into AST subtrees through direct immutable transformations.
- **`StudioColorMath`**: Advanced perceptual color space mathematics (OKLab/RGB/HSL) specific to the rendering engine.
- **`StudioFonts`**: Font metrics calculation, typography presets, and scaling abstractions.
