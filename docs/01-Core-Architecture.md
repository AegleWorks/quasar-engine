# 1. Core Architecture (`Model/` & `Types/`)

Foundational types and central facade orchestrating the engine.

## `DocumentModel`
The primary entry point and orchestrator of the engine. Manages the **Green Tree** (immutable structural syntax tree) and the **Red Tree** (mutable facade with absolute offsets). Exposes methods for atomic transactions, semantic queries, and snapshot generation.

## `TagRegistry`
The central registry of supported BBCode tags. Defines syntax schemas, attribute models, semantic validation rules, and rendering delegates.

## `TagDefinitions`
Native implementations of standard `TagDefinition` rules bundled by default with the engine (e.g., `bold`, `color`, `quote`, `youtube`, `gradient`).

## Foundational Types
- **`Types/core`**: Base AST node definitions (`NodeId`, `NodeKind`, `DocumentNode`, `DocumentSnapshot`, `DocumentChangeEvent`).
- **`Types/operations`**: Mutation primitives (`Operation`, `InsertNodeOperation`, `ReplaceTextOperation`, etc.).
- **`Types/tokens`**: Lexer output tokens (`Token`, `Trivia`, `TokenStream`).
