# 7. Extensibility (`Plugins/`)

Subsystems enabling extensions to modify and augment engine capabilities without tight coupling to the core compiler.

## `PluginAPI`
The `PluginRegistry` serves as QuasarEngine's extension backbone, allowing external packages to register runtime contributions dynamically:
- **Custom Tags**: New `TagDefinition` schemas and execution handlers.
- **Custom Diagnostics**: Additional `DiagnosticRule` definitions for the semantic analyzer.
- **Custom Transformers**: Injecting pipeline passes and transformers into the compilation cycle.

This design ensures the compiler grows modularly without accumulating monolithic domain coupling.
