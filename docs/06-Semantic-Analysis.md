# 6. Semantic Analysis & Intelligence (`Semantic/`, `Queries/`, `Symbols/`)

LSP-grade (Language Server Protocol) code intelligence, validation, and editor services.

## `SemanticAnalyzer` & `Rules`
- **`SemanticAnalyzer`**: Diagnostic engine running validation rules across the AST to emit errors, warnings, and lints.
- **`Rules`**: Modular linting rules, including `EmptyTagRule` (unpopulated tags), `NestingRule` (disallowed nesting hierarchies), and `DeprecatedTagRule` (obsolete syntax).
- **`diagnostics`**: Standardized diagnostic schemas providing severity levels and automated refactoring solutions via `DiagnosticFix`.

## `QueryEngine`
Structural query engine for traversing and selecting syntax nodes using a selector syntax inspired by CSS (e.g., `paragraph > bold`).

## `SymbolTable`
Tracks identifiers, scopes, definitions, and references throughout the document, enabling IDE capabilities such as *Go-To-Definition* and reference counting.
