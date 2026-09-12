# 2. Syntax & Parsing (`Lexer/` & `Syntax/`)

The compilation pipeline transforming raw BBCode text into an Abstract Syntax Tree (AST).

## `Lexer` & `IncrementalLexer`
Converts raw string input into a token stream while faithfully preserving `Trivia` (leading and trailing whitespace, linebreaks).  
The **`IncrementalLexer`** optimizes this process by re-scanning only modified source ranges, minimizing computational overhead in large documents.

## `TreeBuilder`
Consumes lexer tokens to assemble the initial hierarchical syntax tree.

## `GreenNode` & `GreenNodePool`
- **`GreenNode`**: The immutable, structural syntax tree. Accurately maps source code spans, shares identical subtrees across edits, and employs the *Flyweight* pattern.
- **`GreenNodePool`**: String interning and flyweight allocation system for `GreenNode` text chunks, drastically reducing memory footprint.

## `RedNode` & `NodeMatcher`
- **`RedNode`**: The mutable facade wrapping the underlying *Green Tree*. Holds absolute position state (`version`, `id`) and enforces the `allowMutation` guard for transaction-safe updates.
- **`NodeMatcher`**: Reconciles and preserves stable node IDs between previous and updated trees during incremental reparsing.
