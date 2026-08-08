# 2. Syntax & Parsing (`Lexer/` & `Syntax/`)

El pipeline que convierte el texto en BBCode crudo hacia el AST (Abstract Syntax Tree).

## `Lexer` & `IncrementalLexer`
Transforman el string en bruto a un flujo (stream) de tokens, preservando cuidadosamente los `Trivia` (espacios en blanco, saltos de línea).
El **IncrementalLexer** es una versión optimizada que re-escanea únicamente los bloques modificados del texto original, ahorrando cómputo en documentos extensos.

## `TreeBuilder`
Consume los tokens generados por el lexer para construir el árbol inicial de sintaxis.

## `GreenNode` & `GreenNodePool`
- **`GreenNode`**: El árbol sintáctico estructural, inmutable. Mapea precisamente el código fuente, comparte estructura y utiliza el patrón *Flyweight*.
- **`GreenNodePool`**: Sistema de *interning* de strings (patrón flyweight) para los bloques de texto de los `GreenNode`, optimizando drásticamente la memoria.

## `RedNode` & `NodeMatcher`
- **`RedNode`**: La fachada mutable que envuelve al *Green Tree*. Contiene estado (`version`, `id`) y expone el flag `allowMutation` para actualizaciones bloqueadas por transacciones.
- **`NodeMatcher`**: Reconcilia los IDs entre el árbol viejo y el nuevo durante el re-parseo incremental.
