# 7. Extensibility (`Plugins/`)

Subsystems enabling extensions to modify and augment engine capabilities without tight coupling to the core compiler.

## `PluginAPI`
The `PluginRegistry` serves as QuasarEngine's extension backbone, allowing external packages to register runtime contributions dynamically:
- **Custom Tags**: New `TagDefinition` schemas and execution handlers.
- **Custom Diagnostics**: Additional `DiagnosticRule` definitions for the semantic analyzer.
- **Custom Effects**: New tag definitions and evaluations in `Utils/EffectMath`; `@miliastry/quasar-studio` layers its authoring model on top.
- **Custom Commands**: Register a `Command` on `PluginAPI.commands`. A command receives the tree and a source selection and returns `changes` (`TextChange[]`) plus where the selection lands; it never mutates the model. The five built-ins (`insert-text`, `delete-node`, `wrap-in-tag`, `split-node`, `merge-nodes`) follow the same contract and can be replaced or extended without a Miliastry kernel.

This design ensures the compiler grows modularly without accumulating monolithic domain coupling.
