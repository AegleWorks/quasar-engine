# 5. Visual Text Studio

Advanced visual effects for Miliastry's Text Studio. The engine's effect kernel
lives in this package (`Utils/EffectMath`); the layer model, presets, detection
and native serialization live in
[`@miliastry/quasar-studio`](../../quasar-studio).

## Effect kernel (`Utils/EffectMath`)

One implementation shared by the tag handlers, `HTMLRenderer` and the studio:

- **`evaluateEffect`**: axis → waveform → easing → colour/size, per character.
- **`waveform` / `axisValue` / `maskValue`**: the three stages.
- **`parseEffectParams` / `stringifyEffectParams`**: the `[gradient=…]` grammar.
- **`parseColorStops` / `mixMultipleStops`**: colour ramps, sRGB or OKLab.

`[gradient]`, `[grow]`, `[rainbow]`, `[paint]` and the legacy `[sinewave]`
tags are registered in `Model/TagRegistry`; the handlers call the kernel and
never keep their own copy of the maths.

## Studio (`@miliastry/quasar-studio`)

- **`StudioLayers`**: the eight layer types (`gradient`, `rainbow`, `grow`,
  `paint`, `hsl`, `rgb-curves`, `posterize`, `case`) and `evaluatePrepared`.
- **`StudioPipeline`**: `processStudioDocument` / `processStudioASTWithRanges`.
- **`StudioSerialize`**: layer ⇄ native Miliastry tag; the expanded form when
  the tag cannot express the layer exactly.
- **`StudioDetect`**: BBCode → colour/effect ranges.
- **`StudioColorMath` / `StudioMath`**: re-exports of the engine kernel.

The old `Transformers/` and `Utils/treeTransformers.ts` families were removed;
they were the pre-split implementation of this engine.
