# 1. Core Architecture (`Model/` & `Types/`)

Los tipos fundacionales y la fachada central que orquesta el motor.

## `DocumentModel`
El punto de entrada principal y centro (hub) del motor. Maneja el **Green Tree** (estructura inmutable) y el **Red Tree** (estado mutable). Expone los métodos para transacciones, consultas y generación de snapshots.

## `TagRegistry`
El registro central de todos los tags BBCode soportados. Define schemas, atributos, validaciones lógicas y delegados de renderizado.

## `TagDefinitions`
Implementaciones nativas de `TagDefinition` que vienen por defecto en el motor (ej: `bold`, `color`, `quote`, `youtube`, `gradient`).

## Tipos Fundacionales
- **`Types/core`**: Definiciones de nodos base (`NodeId`, `NodeKind`, `DocumentNode`, `DocumentSnapshot`, `DocumentChangeEvent`).
- **`Types/operations`**: Primitivas de mutación (`Operation`, `InsertNodeOperation`, `ReplaceTextOperation`, etc.).
- **`Types/tokens`**: Definiciones de salida del Lexer (`Token`, `Trivia`, `TokenStream`).
