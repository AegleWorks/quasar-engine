# 6. Semantic Analysis & Intelligence (`Semantic/`, `Queries/`, `Symbols/`)

Características estilo LSP (Language Server Protocol) para inteligencia de código, validación y soporte de editores enriquecidos.

## `SemanticAnalyzer` & `Rules`
- **`SemanticAnalyzer`**: Motor que corre reglas de validación a través de todo el AST y produce diagnósticos (errores, advertencias, lints).
- **`Rules`**: Reglas individuales de linting, por ejemplo: `EmptyTagRule` (etiquetas vacías), `NestingRule` (anidamiento incorrecto), `DeprecatedTagRule` (uso de sintaxis vieja).
- **`diagnostics`**: Interfaces que estandarizan un `Diagnostic`, su nivel de severidad y proveen soluciones programáticas a través de `DiagnosticFix`.

## `QueryEngine`
Sistema de consultas avanzado para buscar nodos específicos usando una sintaxis similar a los selectores CSS de la web (por ejemplo: `paragraph > bold`).

## `SymbolTable`
Rastrea IDs, referencias y definiciones a través del documento entero, habilitando funcionalidades de IDE moderno como *Go-To-Definition*.
