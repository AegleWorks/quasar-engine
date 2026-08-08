# 🌌 Quasar Document Engine — Arquitectura Desnuda

> *Versión 1.0.0 — Análisis Forense de Código Fuente*
> *Inspirado en Microsoft Roslyn, Apple SwiftSyntax, Tree-sitter y ProseMirror*
> *Por el equipo de Miliastry Nova — Documento generado por Buffy (Análisis Estructural)*

---

## 📋 Índice

1. [¿Qué es Quasar?](#1-qué-es-quasar)
2. [Filosofía Central](#2-filosofía-central)
3. [El Problema Que Resuelve](#3-el-problema-que-resuelve)
4. [Arquitectura General: Mapa de 30.000 pies](#4-arquitectura-general-mapa-de-30000-pies)
5. [Pipeline Completo (Fase por Fase)](#5-pipeline-completo-fase-por-fase)
6. [Sistema de Tipos (Types/)](#6-sistema-de-tipos-types)
7. [Lexer — Análisis Léxico (Lexer/)](#7-lexer--análisis-léxico-lexer)
8. [GreenNode — El Árbol Inmutable (Syntax/GreenNode)](#8-greennode--el-árbol-inmutable-syntaxgreennode)
9. [RedNode — La Fachada de Estado (Syntax/RedNode)](#9-rednode--la-fachada-de-estado-syntaxrednode)
10. [GreenNodePool — Flyweight & Deduplicación (Syntax/GreenNodePool)](#10-greennodepool--flyweight--deduplicación-syntaxgreennodepool)
11. [TreeBuilder — De Tokens a Árbol (Syntax/TreeBuilder)](#11-treebuilder--de-tokens-a-árbol-syntaxtreebuilder)
12. [NodeMatcher — Correspondencia Entre Versiones (Syntax/NodeMatcher)](#12-nodematcher--correspondencia-entre-versiones-syntaxnodematcher)
13. [BBCode Parser — El Corazón BBCode (BBCode/Parser)](#13-bbcode-parser--el-corazón-bbcode-bbcodeparser)
14. [BBCodeDocumentModel — Puente BBCode (BBCode/BBCodeDocumentModel)](#14-bbcodeDocumentmodel--puente-bbcode-bbcodedocumentmodel)
15. [BBCodeToGreenNode — Convertidores (BBCode/BBCodeToGreenNode)](#15-bbcodetogreennode--convertidores-bbcodetogreennode)
16. [DocumentModel — El Orquestador Central (Model/DocumentModel)](#16-documentmodel--el-orquestador-central-modeldocumentmodel)
17. [TagRegistry — Registro de Etiquetas (Model/TagRegistry)](#17-tagregistry--registro-de-etiquetas-modeltagregistry)
18. [NodeFactory — Fábrica de Nodos (Model/NodeFactory)](#18-nodefactory--fábrica-de-nodos-modelnodefactory)
19. [IncrementalParser — Parseo Incremental (Incremental/)](#19-incrementalparser--parseo-incremental-incremental)
20. [ChangeTracker — Rastreo de Cambios (Incremental/ChangeTracker)](#20-changetracker--rastreo-de-cambios-incrementalchangetracker)
21. [TreeDiffer — Diferenciación de Árboles (Diff/TreeDiffer)](#21-treediffer--diferenciación-de-árboles-difftreediffer)
22. [SemanticAnalyzer — Análisis Semántico (Semantic/)](#22-semanticanalyzer--análisis-semántico-semantic)
23. [EventBus — Sistema de Eventos (Events/EventBus)](#23-eventbus--sistema-de-eventos-eventseventbus)
24. [Transaction & UndoManager — Transacciones (Transactions/)](#24-transaction--undomanager--transacciones-transactions)
25. [Command System — Sistema de Comandos (Commands/)](#25-command-system--sistema-de-comandos-commands)
26. [QueryEngine — Motor de Consultas (Queries/QueryEngine)](#26-queryengine--motor-de-consultas-queriesqueryengine)
27. [SymbolTable — Tabla de Símbolos (Symbols/SymbolTable)](#27-symboltable--tabla-de-símbolos-symbolssymboltable)
28. [Formatter — Formateador (Formatter/)](#28-formatter--formateador-formatter)
29. [Linter — Inspección de Calidad (Linter/)](#29-linter--inspección-de-calidad-linter)
30. [Visitor Pattern — Patrón Visitante (Visitors/Visitor)](#30-visitor-pattern--patrón-visitante-visitorsvisitor)
31. [HTMLRenderer — Renderizador HTML (Visitors/HTMLRenderer)](#31-htmlrenderer--renderizador-html-visitorshtmlrenderer)
32. [BBCodeExporter — Exportador BBCode (Visitors/BBCodeExporter)](#32-bbcodeexporter--exportador-bbcode-visitorsbbcodeexporter)
33. [DOMMorpher — Morphing DOM (Visitors/DOMMorpher)](#33-dommorpher--morphing-dom-visitorsdommorpher)
34. [Otros Exportadores (MarkdownExporter, JSONExporter, SVGRenderer, TiptapExporter)](#34-otros-exportadores-markdownexporter-jsonexporter-svgrenderer-tiptapexporter)
35. [RenderPipeline — Pipeline de Renderizado (RenderPipeline/)](#35-renderpipeline--pipeline-de-renderizado-renderpipeline)
36. [RenderTree — Árbol Intermedio (RenderPipeline/RenderTree)](#36-rentree--árbol-intermedio-renderpipelinerendertree)
37. [Plugin System — Sistema de Plugins (Plugins/)](#37-plugin-system--sistema-de-plugins-plugins)
38. [Transformers — Transformadores (Transformers/)](#38-transformers--transformadores-transformers)
39. [treeTransformers — Transformadores Funcionales (Utils/treeTransformers)](#39-treetransformers--transformadores-funcionales-utilstreetransformers)
40. [Studio Integration — Integración con TextStudio (Studio/)](#40-studio-integration--integración-con-textstudio-studio)
41. [Color Utils — Matemática de Color (Utils/color)](#41-color-utils--matemática-de-color-utilscolor)
42. [HTML Bridge — De HTML a AST (HTML/)](#42-html-bridge--de-html-a-ast-html)
43. [Markdown Bridge — De Markdown a AST (Markdown/)](#43-markdown-bridge--de-markdown-a-ast-markdown)
44. [Bridges — Arquitectura Multi-Formato](#44-bridges--arquitectura-multi-formato)
45. [API Pública (index.ts)](#45-api-pública-indexts)
46. [Pruebas y Cobertura](#46-pruebas-y-cobertura)
47. [Diagrama Completo de Dependencias](#47-diagrama-completo-de-dependencias)
48. [Análisis Crítico: Fortalezas y Debilidades](#48-análisis-crítico-fortalezas-y-debilidades)
49. [Guía de Contribución](#49-guía-de-contribución)
50. [Glosario](#50-glosario)

---

## 1. ¿Qué es Quasar?

**Quasar Document Engine** (`@miliastry/quasar`) es un **motor industrial de análisis, transformación y renderizado de documentos sintácticos** escrito en TypeScript puro. No es "un parser de BBCode". BBCode es solo **una** de las múltiples representaciones que Quasar puede procesar.

Quasar implementa la arquitectura **Red-Green Tree** (Árbol Rojo-Verde) —el mismo patrón usado por el compilador de C# (Roslyn) y el compilador de Swift (SwiftSyntax)— para ofrecer:

- **Inmutabilidad estructural** con `GreenNode`
- **Fachada de estado mutable** con `RedNode`
- **Parseo incremental** en microsegundos
- **Round-tripping** perfecto (preservación total de trivia)
- **Multi-formato**: BBCode, HTML, Markdown, JSON, SVG, Tiptap/ProseMirror
- **Cero dependencias** externas en runtime

---

## 2. Filosofía Central

Quasar se construye sobre **cinco principios** derivados de la teoría de compiladores:

### 2.1 Representación Sintáctica Única
Los documentos NO se almacenan como strings. La representación oficial es un **AST (Abstract Syntax Tree)**. El texto es solo una serialización del árbol.

### 2.2 Inmutabilidad de Datos Sintácticos
`GreenNode` nunca muta. Cualquier modificación del documento genera un nuevo árbol que reutiliza subárboles no afectados por referencia (`===`). Esto permite:
- **Structural Sharing**: Dos nodos idénticos en distintas partes del árbol comparten la misma referencia en RAM.
- **Comparación O(1)**: `greenA === greenB` → los subárboles son idénticos, no hace falta recorrerlos.
- **Thread-safety**: Múltiples componentes pueden leer el árbol simultáneamente sin locks.

### 2.3 Error-Tolerant Parsing (Resiliencia)
El parser **jamás colapsa**. Ante sintaxis inválida (etiquetas mal anidadas, cierres huérfanos, atributos corruptos), el parser:
1. Produce un árbol válido de todas formas
2. Emite nodos `error` con diagnósticos
3. Continúa parseando sin lanzar excepciones

### 2.4 Round-Tripping (Fidelidad Total)
Quasar preserva el **100% de los caracteres originales**: espacios, saltos de línea, comillas de atributos, todo. BBCode → AST → BBCode debe producir exactamente el texto original (excepto por normalizaciones explícitas).

### 2.5 Separación Sintaxis/Semántica
La estructura del árbol (`GreenNode`/`RedNode`) es independiente del **significado** de los nodos. La semántica (validación de colores, enlaces rotos, reglas de negocio) vive en `SemanticAnalyzer` y `Linter`.

---

## 3. El Problema Que Resuelve

### Antes de Quasar

Miliastry Nova tenía un parser de BBCode legacy que:
- Producía un array plano `BBBlock[]` sin jerarquía real
- No preservaba trivia (espacios, newlines exactos)
- No soportaba parseo incremental → re-parseaba todo el documento en cada tipeo
- Estaba acoplado a un solo formato (BBCode)
- No tenía sistema de plugins

### Lo que Quasar aporta

| Problema | Solución Quasar |
|----------|-----------------|
| Latencia en edición > 5ms | Parseo incremental < 0.15ms |
| Sin round-trip (BBCode perdía formato) | Trivia preservation via `fullWidth` |
| Solo BBCode | Bridges: BBCode + HTML + Markdown + JSON |
| Sin undo/redo | `Transaction` + `UndoManager` |
| Sin validación en vivo | `SemanticAnalyzer` + `Linter` |
| Sin inspectabilidad | `QueryEngine` estilo CSS |
| Sin extensibilidad | `PluginRegistry` + `PluginAPI` |
| Sin efectos visuales | `Transformers` + `treeTransformers` + `Studio` |

---

## 4. Arquitectura General: Mapa de 30.000 pies

```
                        ┌──────────────────────┐
                        │     Source Text       │
                        │  (BBCode/HTML/MD)     │
                        └──────────┬───────────┘
                                   │
                            ┌──────▼──────┐
                            │   Lexer     │ ← scanBBCode(), scanMarkdown()
                            └──────┬──────┘
                                   │ Tokens + Trivia
                            ┌──────▼──────┐
                            │   Parser    │ ← parseTokensToGreen(), parseMarkdown()
                            └──────┬──────┘
                                   │
                      ┌────────────▼────────────┐
                      │     GreenNode Tree      │ ← INMUTABLE, compartible
                      └────────────┬────────────┘
                                   │ .green
                      ┌────────────▼────────────┐
                      │      RedNode Tree       │ ← Fachada mutable con IDs
                      └────────────┬────────────┘
                                   │
                      ┌────────────▼────────────┐
                      │   DocumentModel          │ ← Orquestador central
                      │   (eventos, undo, query) │
                      └────────────┬────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
         ┌─────────────┐   ┌─────────────┐   ┌──────────────┐
         │  Semántica   │   │  Comandos   │   │   Visitors   │
         │+ Diagnósticos│   │+ Transacción│   │+ Exportadores│
         └──────────────┘   └─────────────┘   └──────┬───────┘
                                                      ▼
                                            ┌────────────────┐
                                            │    HTML/SVG/   │
                                            │ JSON/MD/Tiptap │
                                            └────────────────┘
```

### Mapa Físico de Archivos

```
packages/quasar/src/
├── BBCode/          # Parser y bridge de BBCode
│   ├── Parser.ts    ← parseTokensToGreen() — el parser central
│   ├── BBCodeDocumentModel.ts ← DocumentModel especializado para BBCode
│   └── BBCodeToGreenNode.ts   ← Convertidores BBBlock ↔ GreenNode
├── Commands/        # Comandos de edición (InsertText, DeleteNode, WrapInTag)
├── Diff/            # TreeDiffer — diff estructural entre dos árboles
├── Events/          # EventBus — pub/sub de eventos del documento
├── Formatter/       # Formateador sintáctico
├── HTML/            # Bridge HTML → GreenNode
├── Incremental/     # IncrementalParser + ChangeTracker
├── Lexer/           # Lexer genérico + BBCodeLexer especializado
├── Linter/          # Reglas de linting (BBCode)
├── Markdown/        # Bridge Markdown → AST → GreenNode
├── Model/           # Core: DocumentModel, TagRegistry, NodeFactory
├── Plugins/         # PluginRegistry + PluginAPI
├── Queries/         # QueryEngine (selectores CSS-like)
├── RenderPipeline/  # Pipeline de renderizado intermedio
├── Semantic/        # SemanticAnalyzer + validadores
├── Studio/          # Motor de efectos visuales (TextStudio)
├── Symbols/         # SymbolTable (definiciones/referencias)
├── Syntax/          # GreenNode, RedNode, TreeBuilder, NodeMatcher, GreenNodePool
├── Transformers/    # Transformadores OOP (Gradient, Rainbow, Grow, SineWave)
├── Transactions/    # Transaction + UndoManager
├── Types/           # Tipos fundamentales del sistema
├── Utils/           # treeTransformers, color, BBCodeGenerator, dom-to-svg
├── Visitors/        # Visitor, HTMLRenderer, BBCodeExporter, MarkdownExporter, etc.
└── Visuals/         # Catálogo de temas visuales (osu.css)
```

---

## 5. Pipeline Completo (Fase por Fase)

El pipeline de Quasar procesa datos en **6 fases deterministas**:

```
        Fase 1           Fase 2          Fase 3            Fase 4
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │    Lexing    │→ │   Parsing    │→ │ Red Hydration│→ │   Semántica  │
  │ Text → Tokens│  │Tokens→Green  │  │Green → Red   │  │Validación y  │
  │              │  │              │  │              │  │Diagnósticos  │
  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
                                                              │
                                                              ▼
                                                     ┌──────────────┐
        Fase 5           Fase 6                     │  Transform   │
  ┌──────────────┐  ┌──────────────┐                │(Si aplica)   │
  │  Visitors/   │  │    Salida    │                └──────────────┘
  │  Exporters   │→ │ HTML/JSON/MD │
  └──────────────┘  └──────────────┘
```

### Fase 1: Lexing
- **Entrada**: Texto fuente (string)
- **Proceso**: `scanBBCode()` o `scanMarkdown()` escanea char por char
- **Salida**: Array de tokens con kind, texto, rango [start, end]
- **Trivia**: Los espacios y newlines nunca se pierden

### Fase 2: Parsing Sintáctico
- **Entrada**: Tokens + texto fuente
- **Proceso**: `parseTokensToGreen()` consume tokens con un stack
- **Salida**: `GreenNode` (árbol inmutable)
- **Resiliencia**: Stack recovery para tags mal anidadas

### Fase 3: Red Hydration
- **Entrada**: `GreenNode`
- **Proceso**: `greenToRedNode()` envuelve cada GreenNode en un RedNode
- **Salida**: `RedNode` con IDs, padres, versión, metadatos
- **Metadata**: Extrae atributos BBCode → metadatos estructurados

### Fase 4: Semántica
- **Entrada**: `RedNode`
- **Proceso**: `SemanticAnalyzer.analyze()` corre validadores
- **Salida**: `DiagnosticCollection` con errores, warnings, hints

### Fase 5: Visitors/Exporters
- **Entrada**: `RedNode`
- **Proceso**: Visitor recorre el árbol y produce output
- **Salida**: HTML, BBCode, Markdown, JSON, SVG, Tiptap

### Fase 6: Transformación (Opcional)
- **Entrada**: `DocumentModel` + parámetros de efecto
- **Proceso**: `applyGradient()`, `RainbowTransformer.transform()`, etc.
- **Salida**: DocumentModel transformado con efectos visuales

---

## 6. Sistema de Tipos (Types/)

El directorio `Types/` contiene los tipos fundamentales que definen el **contrato** de todo el sistema. Ningún otro módulo importa de aquí —es la base.

### 6.1 `core.ts` — Tipos Centrales

```typescript
// La identidad de un nodo (UUID estable que sobrevive re-parses)
type NodeId = string & { readonly __brand: 'NodeId' }

// 46 kinds semánticos — desde 'document' hasta 'unknown'
type NodeKind = 
  | 'document' | 'paragraph' | 'text'
  | 'bold' | 'italic' | 'underline' | 'strikethrough'
  | 'color' | 'font_size' | 'font' | 'shadow'
  | 'code' | 'inline_code' | 'spoiler'
  | 'url' | 'email' | 'profile'
  | 'image' | 'video' | 'audio' | 'imagemap' | 'imagemap_area'
  | 'quote' | 'notice' | 'spoilerbox' | 'box'
  | 'list' | 'list_item'
  | 'heading' | 'center' | 'right'
  | 'zalgo' | 'aesthetic' | 'sparkle' | 'bubble' | 'flower'
  | 'gradient' | 'grow' | 'sinewave' | 'rainbow'
  | 'spacing' | 'empty_line' | 'group' | 'custom' | 'error' | 'unknown'

// Atributos de un nodo (ej: color=#FF0000, size=150)
type NodeAttributes = Record<string, string | number | boolean | null | undefined>

// Interfaz pública del DocumentNode (usada por consumidores externos)
interface DocumentNode {
  id: NodeId
  version: number
  kind: NodeKind
  text: string
  attributes: NodeAttributes
  metadata: NodeMetadata
  children: DocumentNode[]
  diagnostics: Diagnostic[]
  sourceRange: SourceRange | null
  parentId: NodeId | null
  isSynthetic: boolean
}
```

**Funciones helper**: `createNodeId()`, `createDocumentNode()`, `cloneNode()`, `getNodeText()`, `walkPreOrder()`, `findById()`.

### 6.2 `tokens.ts` — Tokens y Trivia

```typescript
type TriviaKind = 'whitespace' | 'newline' | 'carriage_return' | 'comment' | 'line_continuation'

interface Trivia {
  kind: TriviaKind
  text: string
  range: Range
}

type TokenKind = 'open_tag' | 'close_tag' | 'self_closing_tag' | 'text' 
  | 'newline' | 'whitespace' | 'attribute_name' | 'attribute_value'
  | 'equals' | 'quote' | 'end_of_file' | 'error'

interface Token {
  kind: TokenKind
  text: string
  range: Range
  name?: string       // Tag name si aplica
  tagText?: string    // Texto completo del tag [b], [/color]
  attrs?: string      // Atributos raw (lo que va entre tag name y ])
  leadingTrivia: Trivia[]
  trailingTrivia: Trivia[]
}
```

**`ArrayTokenStream`**: Implementación concreta de `TokenStream` que permite `peek()`, `advance()`, `lookAhead()`, `seek()`, etc.

### 6.3 `diagnostics.ts` — Diagnósticos

```typescript
type DiagnosticSeverity = 'hint' | 'info' | 'warning' | 'error'

interface Diagnostic {
  id: string
  code: string           // Ej: 'invalid-color', 'missing-close-tag'
  message: string
  severity: DiagnosticSeverity
  tags: DiagnosticTag[]
  range: Range | null
  nodeId: NodeId | null
  nodeKind: NodeKind | null
  source: string         // 'document-engine' o nombre del plugin
  related?: DiagnosticRelatedInfo[]
  fixes?: DiagnosticFix[]  // Fixes sugeridos (auto-aplicables o no)
}
```

### 6.4 `operations.ts` — Operaciones de Transacción

Define **13 tipos de operación** que son las unidades atómicas de cambio:

| Operación | Descripción |
|-----------|-------------|
| `insert_node` | Insertar un nodo hijo en una posición |
| `delete_node` | Eliminar un nodo |
| `replace_node` | Reemplazar un nodo por otro |
| `move_node` | Mover un nodo de padre/índice |
| `update_attributes` | Cambiar atributos |
| `set_text` | Cambiar el texto |
| `insert_text` | Insertar texto en un nodo |
| `delete_text` | Eliminar texto de un nodo |
| `replace_text` | Reemplazar texto |
| `wrap_in_tag` | Envolver en un tag |
| `unwrap_node` | Desenvolver (remover tag, preservar hijos) |
| `split_node` | Partir un nodo en dos |
| `merge_nodes` | Fusionar dos nodos adyacentes |

### 6.5 `queries.ts` — Sistema de Queries

Define selectores CSS-like para el `QueryEngine`:

```typescript
type QuerySelector =
  | { type: 'kind'; kind: NodeKind }
  | { type: 'tag'; tag: string }
  | { type: 'attribute'; name: string; value?: string }
  | { type: 'has_attribute'; name: string }
  | { type: 'text'; pattern: string }
  | { type: 'has_child'; selector: QuerySelector }
  | { type: 'has_descendant'; selector: QuerySelector }
  | { type: 'nth_child'; n: number }
  | { type: 'first_child' }
  | { type: 'last_child' }
  | { type: 'position'; min?: number; max?: number }
  | { type: 'depth'; min?: number; max?: number }
```

Incluye **combinadores**: `child` (>), `descendant` (espacio), `adjacent` (+), `sibling` (~).

### 6.6 `symbols.ts` — Símbolos

Define el sistema de símbolos para características IDE-like:
- `SymbolKind`: tag, id_definition, id_reference, class, property, variable, function, module, snippet, template
- `SymbolInfo`: nombre, kind, definitionNodeId, references[]
- `SymbolSearchResult`: symbol + score

---

## 7. Lexer — Análisis Léxico (Lexer/)

### 7.1 Lexer Genérico (`Lexer.ts`)

```typescript
class Lexer {
  constructor(options: LexerOptions)
  tokenize(source: string): TokenStream
  retokenize(source: string, start: number, end: number): Token[]
}
```

Es un framework de lexer **agnóstico al lenguaje**. Recibe reglas `LexerRule[]` que definen:
- `pattern`: RegExp para hacer match
- `kind`: TokenKind a producir
- `name?`: Función para extraer nombre del match
- `attrs?`: Función para extraer atributos

El Lexer genérico NO se usa directamente para BBCode. El BBCode tiene su propio lexer optimizado.

### 7.2 BBCodeLexer (`BBCodeLexer.ts`)

**El lexer verdadero de BBCode.** Es una **función pura** (sin estado, sin clase):

```typescript
function scanBBCode(source: string): BBCodeToken[]
```

Produce 4 tipos de token:

```typescript
interface BBCodeOpenToken { kind: 'open'; tag: string; attrs: string; start: number; end: number }
interface BBCodeCloseToken { kind: 'close'; tag: string; start: number; end: number }
interface BBCodeTextToken { kind: 'text'; value: string; start: number; end: number }
interface BBCodeNewlineToken { kind: 'newline'; value: string; start: number; end: number }
```

**Características críticas:**

1. **Newlines como tokens explícitos**: `\n` y `\r\n` son tokens separados, no se mezclan con text.
2. **Bracket depth tracking**: Para tags como `[box=[b]title[/b]]`, rastrea la profundidad de `[` para encontrar el `]` correcto.
3. **Manejo de raw blocks**: `[code]` y `[c]` tratan todo su contenido como texto literal — sin parsear tags internos ni newlines.
4. **Validación de tag names**: Solo `[a-zA-Z0-9_*]+` son tags válidos. `[Gateron]` o `[90 misses]` se tratan como texto plano.
5. **Resiliencia**: Si encuentra `[` inválido (sin `]` correspondiente), emite `[` como texto y continúa.

---

## 8. GreenNode — El Árbol Inmutable (Syntax/GreenNode)

**GreenNode es el corazón del motor.** Es la representación "compilada" del texto fuente.

```typescript
class GreenNode {
  readonly kind: string           // Kind sintáctico
  readonly text: string           // Texto raw (vacío para nodos internos)
  readonly children: readonly GreenNode[]  // Hijos (congelados)
  readonly range: Range           // [start, end] en el texto original
  readonly width: number          // Ancho en caracteres (end - start)
  readonly fullWidth: number      // Ancho total incluyendo trivia
  readonly isLeaf: boolean        // true si no tiene hijos
}
```

### Propiedades Clave

**1. Zero Parent Pointers**: `parent` no existe. Esto permite Structural Sharing.

**2. Inmutabilidad total**: El constructor congela el array de hijos con `Object.freeze()`.

**3. Structural Sharing Ready**: Dos GreenNodes sintácticamente idénticos comparten la misma referencia. Al ser inmutables, esto es seguro.

**4. fullWidth**: Incluye trivia (espacios, newlines). Crucial para round-tripping.

```typescript
// Constructores helper
function greenNode(kind, text, start, end, children?, leadingWidth?): GreenNode
function greenLeaf(kind, text, start, end): GreenNode
```

### Métodos de GreenNode

- `childAt(index)`: O(1) acceso a hijo
- `findChild(predicate)`: Find lineal
- `walk(visitor)`: Recorrido pre-order
- `toString()`: Debug string con indentación
- `getSourceText(source)`: Extrae el texto fuente original de este nodo
- `isKind(kind)`: Comparación de kind

---

## 9. RedNode — La Fachada de Estado (Syntax/RedNode)

**RedNode es la capa mutable que envuelve GreenNode.** Mientras GreenNode es el "código compilado", RedNode es el "entorno de ejecución".

```typescript
class RedNode {
  readonly green: GreenNode       // Referencia al GreenNode subyacente
  readonly id: NodeId             // UUID estable que sobrevive re-parses
  parent: RedNode | null          // Referencia al padre (null para root)
  children: RedNode[]             // Hijos mutables
  version: number                 // Versión para change tracking
  diagnostics: Diagnostic[]       // Diagnósticos de este nodo
  kind: NodeKind                  // Kind semántico
  metadata: NodeMetadata          // Metadatos (atributos BBCode, estilo, etc.)
}
```

### Características Críticas

**1. Mutation Lock**: `RedNode._isMutating` es una bandera estática que previene mutaciones accidentales. Solo se puede mutar dentro de `RedNode.allowMutation(() => {...})`.

```typescript
// Esto lanza error:
root.appendChild(child)  // ❌ "RedNode mutation is only allowed within a transaction boundary"

// Esto funciona:
RedNode.allowMutation(() => {
  root.appendChild(child)  // ✅
})
```

**2. Identidad Estable**: El `id` (UUID) se asigna en creación y NO cambia aunque el contenido cambie. Esto permite:
- Mantener selecciones del cursor después de re-parses
- Animar transiciones (smooth DOM updates)
- Undo/redo consistente

**3. Navegación Bidireccional**:
- `.parent`: Subir en el árbol
- `.children[]`: Bajar
- `.root`: Obtener la raíz
- `.depth`: Distancia desde la raíz
- `.previousSibling` / `.nextSibling`: Hermanos
- `.index`: Índice en el padre

**4. Métodos de Mutación** (requieren allowMutation):
- `appendChild(child)`
- `insertChildAt(index, child)`
- `removeChild(id)`
- `replaceChild(id, newChild)`
- `bumpVersion()`

**5. Conversión**: `toDocumentNode()` produce el `DocumentNode` público. `findById(id)` busca recursivamente. `findNodeAtOffset(offset)` encuentra el nodo en una posición de texto.

---

## 10. GreenNodePool — Flyweight & Deduplicación (Syntax/GreenNodePool)

**Pool de deduplicación usando el patrón Flyweight.**

```typescript
class GreenNodePool {
  static instance: GreenNodePool  // Singleton
  
  internLeaf(kind, text, start?, end?, leadingWidth?): GreenNode
  internNode(kind, text, children, start?, end?): GreenNode
  clear(): void
  get stats(): GreenNodePoolStats
}
```

### Cómo funciona

Cuando creas dos hojas de texto con el mismo contenido:

```typescript
const a = GreenNodePool.instance.internLeaf('text', 'Hello')
const b = GreenNodePool.instance.internLeaf('text', 'Hello')
a === b  // true! Misma referencia en RAM
```

**Cache key**: `${kind}:${text}:${leadingWidth}` para leaves. Para nodos internos: `NODE:${kind}:${text}:${childrenKeys}`.

**Estadísticas**: `size` (entradas en caché), `hits` (aciertos), `misses` (creaciones nuevas), `deduplicatedCount`.

**Impacto**: En documentos con texto repetitivo (listas de items similares), puede reducir el consumo de memoria significativamente y acelerar comparaciones a O(1).

---

## 11. TreeBuilder — De Tokens a Árbol (Syntax/TreeBuilder)

Puente entre el lexer y el árbol sintáctico. Es **agnóstico al lenguaje** — usa factories registrados.

```typescript
class TreeBuilder {
  register(kind: string, factory: NodeFactory): void
  build(stream: TokenStream): BuildResult
  buildGreen(tokens: Token[]): GreenNode
  buildRed(green: GreenNode, parent?, kind?): RedNode
  createRedFromChildren(kind, text, start, end, children, parent?): RedNode
}
```

Por defecto, `buildGreen()` produce un documento plano con todos los tokens como hijos directos. Los parsers específicos (BBCode, Markdown) **reemplazan** este comportamiento.

Incluye un mapa `tagToKind()` que traduce tags BBCode a NodeKind (`'b' → 'bold'`, `'img' → 'image'`, etc.).

---

## 12. NodeMatcher — Correspondencia Entre Versiones (Syntax/NodeMatcher)

**Compara árboles viejos y nuevos para determinar qué cambió.**

```typescript
class NodeMatcher {
  match(oldRoot: RedNode, newRoot: RedNode): NodeMatch
  fingerprint(node: RedNode): string
}
```

### Estrategia de Matching (3 fases):

1. **Fase 1 — Match por ID estable**: Si `oldNode.id === newNode.id`, están matched. Determina si es `exact`, `moved` (cambió posición) o `updated` (cambió contenido).

2. **Fase 2 — Match por fingerprint**: Para nodos sin match por ID, calcula un fingerprint (kind + texto aplanado) y matchea por contenido.

3. **Fase 3 — Restantes**: Los que no matchearon son `inserted` (nuevos) o `deleted` (eliminados).

**Resultado**: `NodeMatch` con `oldToNew`, `newToOld`, `matches[]`, `stats`.

**Uso crítico**: Mantener selección del cursor, scroll position, y animaciones smooth entre re-parses.

---

## 13. BBCode Parser — El Corazón BBCode (BBCode/Parser)

**El parser sintáctico de BBCode.** Consume `BBCodeToken[]` y produce `GreenNode`.

```typescript
function parseTokensToGreen(
  tokens: BBCodeToken[],
  source: string,
  options?: ParseOptions
): GreenNode

function parseBBCode(source: string, options?: ParseOptions): GreenNode
```

### Algoritmo de Parsing

Usa una **Pila Sintáctica (Syntax Stack)** para manejar tags anidados:

```
parseTokensToGreen(tokens, source) {
  root = []
  stack = []  // [{ tag, attrs, children[], start }]
  
  for each token:
    if newline: 
      → emite spacing (1er newline) + empty_line (2do+)
    if text:
      → greenNode('text', ...) → addToParent()
    if open tag:
      if tag desconocido → trata como texto (NO como tag)
      if '*' (list item) → auto-cierra el [*] anterior
      → push al stack
    if close tag:
      strict mode: solo matchea tope del stack
      legacy mode: busca hacia atrás y auto-cierra tags internos
      → pop del stack, emite greenNode()
  
  → Cierra tags no cerrados (todo lo que quedó en el stack)
  → Normaliza: agrupa contenido inline en <paragraph>
  → Devuelve greenNode('document', ..., normalizedRoot)
}
```

### Modos de Parsing

| Modo | Comportamiento |
|------|---------------|
| **Legacy (default)** | Auto-cierra tags internos. Tags de cierre huérfanos se ignoran. Compatible con osu! |
| **Strict** | Solo matchea el tope del stack. Tags mal cerrados emiten nodos 'error' con diagnóstico |

### Normalización de Párrafos

Después del parseo, el contenido inline se agrupa en nodos `paragraph`:

```typescript
// Input: "Hello [b]World[/b]"
// Output: document → paragraph → [text("Hello "), bold → text("World")]

// Input: "Hello\n\nWorld"
// Output: document → [paragraph → text("Hello"), empty_line, paragraph → text("World")]
```

Esto es fundamental para que el renderizador HTML produzca párrafos correctos.

### Tratamiento de Newlines

- **1er newline consecutivo**: `greenNode('spacing')` → renderizado como `<br>` (o ignorado en bloques)
- **2do+ newlines consecutivos**: `greenNode('empty_line')` → renderizado como separador de párrafos

---

## 14. BBCodeDocumentModel — Puente BBCode (BBCode/BBCodeDocumentModel)

**DocumentModel especializado para BBCode.** Hereda de `DocumentModel` y sobreescribe `parseToGreen()` y `buildRedFromGreen()`.

```typescript
class BBCodeDocumentModel extends DocumentModel {
  constructor(options?: BBCodeDocumentModelOptions)
  protected parseToGreen(source: string): GreenNode
  protected buildRedFromGreen(green: GreenNode): RedNode
}
```

**Flujo**:
```
BBCode text
  ↓ scanBBCode() [Lexer]
BBCodeToken[]
  ↓ parseTokensToGreen() [Parser]
GreenNode
  ↓ greenToRedNode() [BBCodeToGreenNode]
RedNode  ← Con metadatos extraídos de atributos BBCode
```

**Modo strict**: Opcional, para validación estricta de anidación.

---

## 15. BBCodeToGreenNode — Convertidores (BBCode/BBCodeToGreenNode)

**Puente entre el parser legacy (BBBlock[]) y el nuevo sistema GreenNode/RedNode.**

```typescript
// BBBlock — formato legacy del parser anterior
interface BBBlock {
  id: string
  tag: string | null
  attrs: string
  content: string
  rawStart: number
  rawEnd: number
  children: BBBlock[]
  attrChildren?: BBBlock[]
  html?: string
}

// Convertidores
function bbBlockToGreenNode(block: BBBlock): GreenNode
function bbBlocksToGreenTree(blocks: BBBlock[], source: string): GreenNode
function greenToRedNode(green: GreenNode, parent?): RedNode
function bbBlocksToRedTree(blocks: BBBlock[], source: string): RedNode
```

### Extracción de Metadatos

La función `extractGreenNodeMetadata()` es crítica: toma un `GreenNode` de BBCode y extrae sus atributos en metadatos estructurados:

```typescript
switch (kind):
  'color'    → { color: value }
  'font_size'→ { size: value }
  'url'      → { href: value || firstChildText() }
  'quote'    → { source: value }
  'box'      → { title: stripBBCode(value) || 'Spoiler' }
  'list'     → { ordered: value === '1' }
  'image'    → { src: value || firstChildText() }
  'video'    → { videoId: value || firstChildText() }
```

### Mapeo Tag → NodeKind

```typescript
TAG_TO_KIND = {
  'b': 'bold', 'i': 'italic', 'u': 'underline',
  's': 'strikethrough', 'color': 'color',
  'size': 'font_size', 'font': 'font',
  'c': 'inline_code', 'code': 'code',
  'img': 'image', 'youtube': 'video',
  'quote': 'quote', 'notice': 'notice',
  'spoilerbox': 'spoilerbox', 'box': 'box',
  'list': 'list', '*': 'list_item',
  // ... más de 30 mapeos
}

function isBlockKind(kind: NodeKind): boolean
```

---

## 16. DocumentModel — El Orquestador Central (Model/DocumentModel)

**La clase central que coordina todos los subsistemas.** Es el punto de entrada para cualquier operación sobre un documento.

```typescript
class DocumentModel {
  // Estado
  private _source: string
  private _language: string
  private _redRoot: RedNode | null
  private _greenRoot: GreenNode | null
  private _version: number
  
  // Sub-sistemas
  readonly tagRegistry: TagRegistry
  readonly nodeFactory: NodeFactory
  readonly treeBuilder: TreeBuilder
  readonly nodeMatcher: NodeMatcher
  readonly semanticAnalyzer: SemanticAnalyzer
  readonly incrementalParser: IncrementalParser
  readonly changeTracker: ChangeTracker
  readonly undoManager: UndoManager
  readonly queryEngine: QueryEngine
  readonly events: DocumentEventBus
}
```

### API Pública

| Método | Descripción |
|--------|-------------|
| `rebuild(source)` | Re-parseo completo del documento |
| `applyChange(change)` | Aplica un cambio de texto (usa parseo incremental) |
| `applyTextUpdate(newSource)` | Calcula diff string y aplica cambio |
| `transact(operations, label?)` | Ejecuta operaciones en una transacción (undoable) |
| `undo()` / `redo()` | Deshacer/rehacer |
| `analyze()` | Corre análisis semántico |
| `findNode(id)` | Busca nodo por ID |
| `query(q)` | Ejecuta consulta QueryEngine |
| `registerValidator(validator)` | Registra validador semántico |
| `toDocumentNode()` | Exporta a DocumentNode público |
| `toString()` | Devuelve el source text |

### Flujo de `applyChange()`

```
applyChange(change):
  1. changeTracker.track(change)
  2. Aplica el cambio al source string
  3. incrementalParser.reparse(oldRed, oldGreen, change, newSource, parseCallback, buildCallback)
     a. Si éxito → actualiza _greenRoot, _redRoot
     b. Si falla → rebuild(source) como fallback
  4. Emite evento 'document_changed' (síncrono)
  5. Agenda tarea en background (setTimeout 10ms):
     a. NodeMatcher.match(oldRoot, newRoot)
     b. SemanticAnalyzer.analyze() (si autoAnalyze)
     c. Emite evento 'diagnostics_updated'
```

### Sistema de Eventos que Emite

- `document_changed` → en cada rebuild, applyChange, transact, undo, redo
- `diagnostics_updated` → después del análisis semántico (debounced)

---

## 17. TagRegistry — Registro de Etiquetas (Model/TagRegistry)

**El registro central de todas las etiquetas/node kinds conocidas.**

```typescript
interface TagDefinition {
  name: string           // 'b', 'color', 'img'
  kind: NodeKind          // 'bold', 'color', 'image'
  label: string           // 'Bold', 'Color'
  category: 'formatting' | 'layout' | 'media' | 'special' | 'text'
  isInline: boolean
  isSelfClosing: boolean
  canHaveChildren: boolean
  isDeprecated?: boolean
  deprecatedReplacement?: string
  
  // Handlers de exportación/renderizado
  toBBCode?: (ctx: TagHandlerContext) => string
  toRenderNode?: (ctx: TagHandlerContext) => RenderNode
  toHTML?: (ctx: TagHandlerContext) => string
  
  // UI
  toolbar?: { group, label, icon?, shortcut? }
  properties?: PropertyDefinition[]
}
```

### Tags Built-in Registrados

**Formatting**: `b, i, u, s, strike, color, size, c, font, shadow, spoiler`

**Text Effects**: `zalgo, aesthetic, sparkle, bubble, flower, gradient, sinewave, grow, rainbow`

**Layout**: `centre, center, right, heading, notice, spacing, empty_line`

**Media**: `img, youtube, audio, imagemap`

**Special**: `quote, code, svg, spoilerbox, box, list, *, url, email, profile, group`

### Handlers de Efectos en TagRegistry

Los tags `gradient`, `sinewave`, `grow`, y `rainbow` tienen implementaciones completas de `toBBCode` y `toRenderNode` que:

1. Extraen el texto plano del contenido (`extractTextContent`)
2. Lo dividen por unidad (character, word, line)
3. Aplican interpolación de color/tamaño usando `globalOffset` y `documentLength`
4. Producen BBCode anidado o RenderNodes con estilo inline

Ejemplo: `[gradient colors=#FF0000,#00FF00]Hello[/gradient]` produce `[color=#FF0000]H[/color][color=#XX]e[/color]...`

---

## 18. NodeFactory — Fábrica de Nodos (Model/NodeFactory)

Crea instancias de `RedNode` a partir de definiciones de `TagDefinition`.

```typescript
class NodeFactory {
  createFromTag(tagName, attrs, start, end, children): RedNode
  createDocumentNode(kind, text, attributes, children): DocumentNode
}
```

**Parsing de atributos**: Usa `PropertyDefinition[]` del tag para parsear attrs string en `NodeAttributes` tipadas.

---

## 19. IncrementalParser — Parseo Incremental (Incremental/)

**El corazón del rendimiento en tiempo real.** En lugar de re-parsear todo el documento, identifica la región mínima afectada y solo re-parsea esa.

```typescript
class IncrementalParser {
  reparse(
    oldRed: RedNode,
    oldGreen: GreenNode,
    change: TextChange,
    newSource: string,
    parseCallback: (text: string) => GreenNode,
    buildRedCallback: (green: GreenNode) => RedNode
  ): ReparseResult | null
}
```

### Algoritmo

```
1. findAffectedNodes(oldRed, change)
   → Recorre desde la raíz, encuentra el nodo más profundo que contiene el cambio
   
2. Traverse up to safeBoundary
   → Sube hasta encontrar un nodo 'safe' (document, quote, box, list)
   → Esto asegura que no estamos re-parsendo dentro de un bloque que no debe romperse

3. Re-parse only affected region
   → Extrae el substring del safe boundary
   → Llama al parseCallback con solo ese substring
   → Obtiene nuevo GreenNode

4. Swap old node with new
   → Reemplaza el safe boundary viejo con el nuevo en el árbol padre
   → Preserva el resto del árbol intacto (por referencia)
```

**Rendimiento**: Operaciones de edición típicas < **0.15 ms**. En documentos de 50 KB, solo se re-parsea una fracción.

**Safe boundaries**: `quote`, `box`, `list`, `center`, `document`. Si el cambio está dentro de un `[quote]`, solo el contenido de ese quote se re-parsea.

---

## 20. ChangeTracker — Rastreo de Cambios (Incremental/ChangeTracker)

Rastrea los cambios de texto para que el `IncrementalParser` sepa qué parsear.

```typescript
class ChangeTracker {
  track(change: TextChange): void
  getAll(): TextChange[]
  getLast(): TextChange | null
  getAffectedRange(count): { start, end } | null
  clear(): void
  getStats(): TextChangeStats
}
```

**Límite**: 100 entradas de historial.

---

## 21. TreeDiffer — Diferenciación de Árboles (Diff/TreeDiffer)

**Compara dos RedNode trees y produce una lista de operaciones diff.**

```typescript
class TreeDiffer {
  diff(oldRoot: RedNode, newRoot: RedNode): DiffResult
}
```

### Tipos de Operación

| Operación | Significado |
|-----------|-------------|
| `preserve` | Mismo ID, misma posición, mismo contenido |
| `update` | Mismo ID, diferente contenido |
| `move` | Mismo ID, diferente posición |
| `insert` | Nuevo nodo (sin match en old) |
| `delete` | Nodo eliminado (sin match en new) |

### Algoritmo

```
1. Construye Mapas: oldMap(ID → node), newMap(ID → node)
2. Itera newChildren:
   - Si ID existe en oldMap y misma posición → preserve (o update si cambió contenido)
   - Si ID existe en oldMap y diferente posición → move
   - Si ID no existe → insert candidate
3. Empareja inserts con deletes por contenido (fingerprint)
4. Lo que queda → inserts reales y deletes reales
```

---

## 22. SemanticAnalyzer — Análisis Semántico (Semantic/)

**Valida reglas de negocio sobre el árbol sintáctico.** Separado del parser por diseño.

```typescript
class SemanticAnalyzer {
  register(validator: Validator): void
  unregister(code: string): void
  analyze(root: RedNode, source: string): AnalyzeResult
  createValidator(code, severity, predicate): Validator
}

interface Validator {
  code: string
  severity: DiagnosticSeverity
  validate(node: RedNode, context: AnalyzerContext): Diagnostic | Diagnostic[] | null
}
```

### Validadores Built-in

| Código | Severidad | Qué detecta |
|--------|-----------|-------------|
| `unknown-tag` | warning | Tags BBCode desconocidos |
| `deprecated-tag` | info | Uso de `[strike]` en vez de `[s]` |
| `empty-tag` | hint | Tags sin contenido (ej: `[b][/b]`) |
| `nested-structure` | warning | Tags BBCode dentro de `[code]` |

---

## 23. EventBus — Sistema de Eventos (Events/EventBus)

**Sistema pub/sub para cambios del documento.**

```typescript
class DocumentEventBus {
  on(type, handler): () => void  // Retorna unsubscribe
  onAny(handler): () => void
  emit(event): void
  off(type, handler): void
  getHistory(): DocumentEvent[]
  clear(): void
}
```

### Tipos de Evento

| Tipo | Cuándo se emite |
|------|-----------------|
| `document_changed` | Rebuild, applyChange, transact |
| `diagnostics_updated` | Después de análisis semántico (debounced) |
| `undo_performed` / `redo_performed` | Undo/redo |
| `cursor_moved` / `selection_changed` | (Reservado para integración con editor) |

---

## 24. Transaction & UndoManager — Transacciones (Transactions/)

### Transaction

**Agrupa operaciones en una unidad atómica y reversible.**

```typescript
class Transaction {
  readonly operations: Operation[]
  readonly id: string
  readonly timestamp: number
  
  apply(root: RedNode): RedNode | null
  invert(root: RedNode): Transaction  // Para undo
  getLabel(): string
}
```

**Inversión**: `invert()` produce una Transaction que deshace la original (invirtiendo el orden y los efectos).

### UndoManager

**Maneja el stack de undo/redo.**

```typescript
class UndoManager {
  push(transaction, label?): void
  undo(): UndoEntry | null
  redo(): UndoEntry | null
  peekUndo(): UndoEntry | null
  peekRedo(): UndoEntry | null
  clear(): void
  // undoCount, redoCount
}
```

- **Límite**: 50 entradas por defecto (configurable)
- **Clear redo on new action**: Al hacer push, el redo stack se limpia

---

## 25. Command System — Sistema de Comandos (Commands/)

**Comandos de alto nivel que producen Transactions.**

```typescript
interface Command {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly shortcut?: string
  execute(ctx: CommandContext): CommandResult
  canExecute?(ctx: CommandContext): boolean
}

class CommandRegistry {
  register(command): void
  unregister(id): void
  get(id): Command | undefined
  execute(id, ctx): CommandResult
  getAll(): Command[]
}
```

### Comandos Built-in

| Comando | ID | Función |
|---------|-----|---------|
| `InsertText` | `insert-text` | Insertar texto en cursor |
| `DeleteNode` | `delete-node` | Eliminar nodo seleccionado |
| `WrapInTag` | `wrap-in-tag` | Envolver selección en tag |
| `SplitNode` | `split-node` | Partir nodo en posición |
| `MergeNode` | `merge-nodes` | Fusionar nodos adyacentes |

**Nota**: Los comandos built-in tienen implementaciones placeholder (stubs). La lógica real está en el pipeline de Transactions.

---

## 26. QueryEngine — Motor de Consultas (Queries/QueryEngine)

**Sistema de consultas estilo CSS sobre el RedNode tree.**

```typescript
class QueryEngine {
  execute(query: Query, root: RedNode): QueryResult
}
```

### Sintaxis de Consultas

```typescript
// Crear una consulta desde string CSS-like
const q = query('paragraph > bold')
const q = query('quote text')
const q = query('[color]')
const q = query('list > *')
const q = query('*:first-child')
const q = query('*:nth-child(3)')
```

### Combinadores

| Símbolo | Significado |
|---------|-------------|
| `>` | Child (hijo directo) |
| ` ` (espacio) | Descendant (cualquier descendiente) |
| `+` | Adjacent sibling (hermano siguiente inmediato) |
| `~` | Any sibling (cualquier hermano) |

### Selectores

- `kind` → `paragraph`, `bold`, `text`
- `tag` → `b`, `color`, `img`
- `[name]` → Tiene atributo
- `[name=value]` → Atributo con valor específico
- `:first-child`, `:last-child`, `:nth-child(n)`
- `text(pattern)` → Texto contiene patrón
- `has_child(selector)` / `has_descendant(selector)`
- `position(min?, max?)` / `depth(min?, max?)`

---

## 27. SymbolTable — Tabla de Símbolos (Symbols/SymbolTable)

**Sistema de símbolos para características IDE-like (go-to-definition, find-references).**

```typescript
class SymbolTable {
  build(root: RedNode): void
  get(name: string): SymbolInfo | undefined
  getSymbolForNode(nodeId): SymbolInfo | undefined
  search(query, maxResults): SymbolSearchResult[]
  getAll(): SymbolInfo[]
  clear(): void
}
```

**En BBCode**, busca atributos `id=` (definiciones) y `goto=` (referencias).

---

## 28. Formatter — Formateador (Formatter/)

**Re-formatea documentos BBCode.** Actualmente tiene una implementación simple que extrae texto plano:

```typescript
class Formatter {
  format(root: RedNode): string
  format(root: RedNode, options?: FormatOptions): string
}
```

**Opsiones planeadas**: `blockNewlines`, `normalizeInlineWhitespace`, `maxLineWidth`, `collapseEmptyLines`, `indent`.

---

## 29. Linter — Inspección de Calidad (Linter/)

**Similar a ESLint pero para documentos BBCode.**

```typescript
class Linter {
  lint(root: RedNode, source: string): LintResult
  
  // Registro de reglas
  register(rule: LintRule): void
  unregister(code: string): void
}
```

### Reglas Built-in

| Regla | Severidad | Descripción |
|-------|-----------|-------------|
| `no-nested-bold` | warning | `[b]` dentro de `[b]` es redundante |
| `no-empty-tags` | hint | Tags vacíos sin efecto |
| `max-quote-depth` | warning | Más de 3 quotes anidados |
| `invalid-url-protocol` | error | URLs con protocolos no seguros (javascript:, file:) |

---

## 30. Visitor Pattern — Patrón Visitante (Visitors/Visitor)

**Clase base abstracta para todos los exportadores y renderizadores.**

```typescript
abstract class Visitor<T = string> {
  abstract visit(node: RedNode, context?: VisitorContext): T
  
  visitChildren(node: RedNode, separator?: string): T[]
  getText(node: RedNode): string
  setContext(context: VisitorContext): void
}
```

**Principio**: En lugar de switch statements sobre tipos de nodo, cada Visitor implementa su propia lógica de dispatch. Esto permite agregar nuevos exportadores sin modificar el árbol.

---

## 31. HTMLRenderer — Renderizador HTML (Visitors/HTMLRenderer)

**El renderizador principal para la vista previa BBCode.** Convierte el RedNode tree a HTML.

```typescript
class HTMLRenderer extends Visitor<string> {
  render(root: RedNode): string
  
  constructor(options?: {
    osuBehaviour?: boolean   // Reproducir quirks de osu! (default: true)
    registry?: TagRegistry   // Para tags custom
  })
}
```

### Dispatch por Kind (más de 30 casos)

Cada NodeKind tiene su propio método de renderizado:

```typescript
switch node.kind:
  'bold'     → <strong>
  'italic'   → <em>
  'underline'→ <u>
  'color'    → <span style="color:...">
  'font_size'→ <span style="font-size:...%">
  'url'      → <a href="..." target="_blank">
  'image'    → <img src="...">
  'video'    → <iframe src="https://youtube.com/embed/...">
  'quote'    → <blockquote>
  'spoilerbox'→ <details><summary>
  'code'     → <pre><code>
  'list'     → <ul>/<ol>
  'center'   → <div style="text-align:center">
  // ... y más
```

### Quirks de osu! (osuBehaviour)

El renderizador tiene compatibilidad con comportamientos específicos de osu!:

1. **Newlines antes de `[code]`**: Los newlines inmediatamente antes de un code block se ignoran (no producen `<br>`)
2. **Empty lines antes de `[code]`**: La última empty_line antes de code se convierte en `\n` literal en lugar de `<br>`
3. **Spacing en block boundaries**: Si un spacing sigue inmediatamente a un block tag (notice, quote, etc.), se renderiza como `\n` en vez de `<br>`

### Atributos data-node-id

Cada elemento HTML incluye `data-node-id="${node.id}"` para permitir:
- Mapeo inverso (click en preview → selección en editor)
- Highlight sincronizado
- Animaciones de transición

---

## 32. BBCodeExporter — Exportador BBCode (Visitors/BBCodeExporter)

**Convierte el RedNode tree de vuelta a texto BBCode.** Esencial para round-tripping.

```typescript
class BBCodeExporter extends Visitor<string> {
  export(root: RedNode): string
  visit(node: RedNode, context?: VisitorContext): string
}
```

**Mapeo Kind → Tag**:

```typescript
'bold' → 'b', 'italic' → 'i', 'underline' → 'u',
'strikethrough' → 's', 'color' → 'color',
'font_size' → 'size', 'inline_code' → 'c',
'center' → 'centre', 'image' → 'img',
'video' → 'youtube', 'list_item' → '*',
// ...
```

**Exportación de efectos**: Los tags `gradient`, `sinewave`, `grow`, `rainbow` usan sus handlers `toBBCode` del `TagRegistry` para producir BBCode anidado (`[color=#FF0000]...[/color]`).

---

## 33. DOMMorpher — Morphing DOM (Visitors/DOMMorpher)

**Actualiza el DOM existente in-place para reflejar nuevo HTML, preservando estado interactivo.**

```typescript
function morphHTML(container: HTMLElement, newHTML: string): void
```

### Algoritmo

```
morphNodes(parent, newParent):
  Itera childNodes en paralelo:
  - Si falta newNode → removeChild
  - Si falta oldNode → appendChild(clone)
  - Si ambos son text nodes → update nodeValue
  - Si ambos son elementos con mismo tagName →:
    • Preserva estado de <details open>
    • Preserva clases 'open', 'is-open'
    • Sincroniza atributos (set/remove)
    • Recurse morphNodes(oldEl, newEl)
  - Si son diferentes → replaceChild(clone)
```

**Esto evita**: parpadeo (flash), pérdida de estado de spoilers/boxes, reinicio de videos/audios.

---

## 34. Otros Exportadores

### MarkdownExporter

Convierte BBCode → Markdown. Mapeos clave:

| BBCode | Markdown |
|--------|----------|
| `[b]` | `**` |
| `[i]` | `*` |
| `[s]` | `~~` |
| `[spoiler]` | `\|\|` |
| `[url=...]` | `[text](url)` |
| `[img]` | `![Image](url)` |
| `[code]` | Triple backtick |
| `[quote]` | `> ` blockquote |

### JSONExporter

Serializa el árbol completo a JSON. Útil para:
- Depuración
- Persistencia estructurada
- Envío por red (colaboración)

### SVGRenderer

**Wraps el HTML output en un SVG `<foreignObject>`**. Permite exportar el preview como SVG sin calcular layouts manualmente.

```html
<svg>
  <foreignObject>
    <div class="bbcode-preview">...HTML...</div>
  </foreignObject>
</svg>
```

### TiptapExporter

Convierte a formato Tiptap/ProseMirror JSON:

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Hello ", "marks": [{ "type": "bold" }] }
      ]
    }
  ]
}
```

---

## 35. RenderPipeline — Pipeline de Renderizado (RenderPipeline/)

**Capa intermedia entre DocumentModel y la salida final.** Permite a plugins interceptar y transformar el renderizado.

```typescript
class RenderPipeline {
  register(hook: RenderHook): void
  render(root: RedNode, variant, registry, source): string
}
```

### Fases

1. **build**: DocumentModel → RenderNode tree
2. **transform**: Plugins transforman el RenderTree
3. **serialize**: RenderNode → Output string (HTML, SVG, etc.)

### RenderHooks

```typescript
interface RenderHook {
  phase: RenderPhase  // 'build' | 'transform' | 'serialize'
  hook: (node: RenderNode, context: RenderContext) => RenderNode | null
}
```

---

## 36. RenderTree — Árbol Intermedio (RenderPipeline/RenderTree)

**Representación intermedia entre DocumentModel y el output final.**

```typescript
interface RenderNode {
  kind: NodeKind | string
  text: string
  children: RenderNode[]
  props: Record<string, unknown>
  variant?: RenderVariant   // 'html' | 'canvas' | 'svg' | 'pdf' | 'react' | 'text'
  className?: string
  style?: Record<string, string | number>
  events?: Record<string, string>
  metadata?: Record<string, unknown>
}

class RenderTree {
  static text(content: string): RenderNode
  static container(kind, children, props?): RenderNode
  static toHTML(node: RenderNode): string
  static fromNode(kind, text?, children?, props?): RenderNode
}
```

---

## 37. Plugin System — Sistema de Plugins (Plugins/)

**Sistema de plugins completo que permite extender Quasar sin modificar su código fuente.**

### PluginRegistry

```typescript
interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  dependencies?: string[]
}

interface PluginContribution {
  tags?: TagDefinition[]
  commands?: Command[]
  validators?: Validator[]
  lintRules?: LintRule[]
  renderHooks?: RenderHook[]
  styles?: string[]
  activate?: () => void | Promise<void>
  deactivate?: () => void
}
```

### PluginAPI

**La API pública expuesta a los plugins:**

```typescript
class PluginAPI {
  readonly model: DocumentModel
  readonly tags: TagRegistry
  readonly commands: CommandRegistry
  readonly semantic: SemanticAnalyzer
  readonly linter: Linter
  readonly renderer: RenderPipeline
  readonly plugins: PluginRegistry
  
  registerPlugin(manifest, contributions): void
  unregisterPlugin(name): void
}
```

---

## 38. Transformers — Transformadores (Transformers/)

**Transformaciones OOP que mutan el DocumentModel produciendo Transactions.**

```typescript
interface Transformer {
  transform(document: DocumentModel): TransformResult
}
```

### ASTOptimizer

Optimiza el árbol sintáctico con reglas:

1. **Remove empty tags**: Elimina tags sin contenido (excepto void tags)
2. **Merge adjacent siblings**: Fusiona tags iguales con mismos atributos separados por spacing
3. **Canonical ordering**: Reordena wrappers para orden canónico (ej: `[color][b] → [b][color]`)

### RainbowTransformer

Aplica efecto arcoíris: cada caracter recibe un color HSL interpolado a través del texto.

```typescript
const transformer = new RainbowTransformer({
  saturation: 80,   // 0-100
  lightness: 60,    // 0-100
  spread: 300,      // grados de hue
  offset: 0
})
transformer.transform(document)
```

### GradientTransformer

Aplica gradiente entre dos colores a través del texto.

```typescript
const transformer = new GradientTransformer({
  from: '#e8b04b',
  to: '#d94f4f',
  unit: 'char',      // o 'word'
  easing: 'linear'   // o 'easeIn', 'easeOut', 'easeInOut'
})
```

### GrowTransformer

Aplica ondas de tamaño (sine wave de font-size).

### SineWaveTransformer

Aplica ondas senoidales de tamaño

---

## 39. treeTransformers — Transformadores Funcionales (Utils/treeTransformers)

**Versión funcional (no OOP) de los transformadores.** Son funciones puras que operan sobre `RedNode`.

### API

```typescript
function applyGradient(root: RedNode, colors: string[], options?): RedNode
function applyGrow(root: RedNode, options?): RedNode
function applyRainbow(root: RedNode, options?): RedNode
function applyCentralGradient(root: RedNode, colors: string[], options?): RedNode
function applyMultiGradient(root: RedNode, colors: string[], options?): RedNode
function applyEffect(root: RedNode, effect: TreeEffect): RedNode
function countTextLength(node: RedNode): number
```

### Algoritmo de Dos Pasadas

1. **countTextLength()**: Cuenta la longitud total de texto plano (omite nodos como img, code)
2. **Walk con wrapping**: Recorre el árbol, y por cada text leaf, lo envuelve en nodos de efecto con metadatos de posición global

**IMPORTANTE**: Los efectos se aplican **dentro** de los tags de formato (b, i, u, color), no los reemplazan. Los nodos estructurales (box, quote, list) se preservan intactos.

### Ejemplo de Transformación

```
Input:  [box][b]Hello[/b] World[/box]
Output: [box][b][gradient]H[/gradient][gradient]e[/gradient]...
              [/b][gradient] [/gradient][gradient]W[/gradient]...[/box]
```

---

## 40. Studio Integration — Integración con TextStudio (Studio/)

**Motor de efectos visuales para TextStudio.** Opera sobre segmentos de texto con wrappers.

### QuasarSegment Model

```typescript
interface QuasarSegment {
  text: string
  wrappers: QuasarWrapper[]     // [{ kind: 'color', text: '=#FF0000' }]
  baseColor?: string
}
```

### Funciones de Efecto

| Función | Efecto |
|---------|--------|
| `applyGradient()` | Gradiente de colores con easing |
| `applyRainbow()` | Arcoíris HSL |
| `applyGrow()` | Ondas de tamaño |
| `applyColorize()` | Coloreado con modos (linear, central, multi, random) |
| `applyRGBCurves()` | Curvas Bezier por canal RGB |
| `applyTextDecoration()` | Efectos Unicode (zalgo, aesthetic, sparkle, bubble) |
| `applyASCIIFont()` | Fuentes Unicode (fullwidth, fraktur, smallcaps, etc.) |

### Studio Layer System

Sistema de capas apilables:

```typescript
type StudioLayer = StudioGradientLayer | StudioRainbowLayer 
  | StudioGrowLayer | StudioRGBLayer
```

Cada capa tiene `enabled`, `id`, y parámetros específicos. Se aplican en orden (de fondo a frente).

**procesStudioAST()**: Toma texto fuente + capas + opciones, y produce un GreenNode/RedNode transformado con todos los efectos aplicados.

---

## 41. Color Utils — Matemática de Color (Utils/color)

**Funciones de color sin dependencias externas.**

```typescript
function mixHex(from: string, to: string, t: number): string     // Interpolación RGB lineal
function mixMultiple(colors: string[], t: number): string          // Interpolación multi-color
function hslToHex(h: number, s: number, l: number): string        // HSL → #RRGGBB
function ease(t: number, kind: Easing): number                    // Easing functions
function clamp(n: number, min?: number, max?: number): number
```

**Easings**: `linear`, `easeIn` (t²), `easeOut` (1-(1-t)²), `easeInOut`.

---

## 42. HTML Bridge — De HTML a AST (HTML/)

**Convierte HTML renderizado de vuelta a GreenNode.** Útil para importar contenido existente.

```typescript
function htmlStringToGreenTree(html: string): GreenNode
function greenToRedNode(green: GreenNode, parent?): RedNode
```

**Mapeo HTML → NodeKind**:

| HTML | Kind |
|------|------|
| `<b>`, `<strong>` | bold |
| `<i>`, `<em>` | italic |
| `<a>` | url |
| `<img>` | image |
| `<h1>`-`<h6>` | heading |
| `<details>` | spoilerbox/box |
| `<blockquote>` | quote |
| `<ul>`/`<ol>` | list |
| `<pre>` | code |
| `<div class="notice">` | notice |
| `<div style="text-align:center">` | center |

---

## 43. Markdown Bridge — De Markdown a AST (Markdown/)

**Convierte Markdown a GreenNode.** Incluye su propio lexer (`scanMarkdown`) y parser (`parseMarkdown`).

### MarkdownLexer

Produce **22 tipos de token**: hash, gt, star, underscore, tilde, backtick, bracket_open/close, paren_open/close, bang, dash, plus, dot, text, newline, fence, hr, escape, angle.

### MarkdownParser

Parser recursivo descendente que produce `MarkdownDocument` (AST):

```
document → [paragraph, heading, code_block, blockquote, notice, list, ...]

paragraph → [text, strong, emphasis, strikethrough, link, image, code_inline, ...]
heading → level + children
blockquote → children (con > prefix)
code_block → lang + value
list → ordered? + [list_item, ...]
link → url + children
image → url + alt
```

### MarkdownToGreenNode

Convierte el AST Markdown a GreenNode/RedNode, mapeando tipos Markdown a `NodeKind`.

---

## 44. Bridges — Arquitectura Multi-Formato

Quasar NO es un parser de BBCode. Es un motor de documentos multi-formato.

```
                    ┌──────────────────────┐
                    │   Quasar Engine       │
                    │   (GreenNode/RedNode) │
                    └──────┬───────────────┘
           ┌────────────────┼────────────────┐
           ▼                ▼                ▼
    ┌────────────┐   ┌────────────┐   ┌────────────┐
    │  BBCode    │   │  Markdown  │   │   HTML     │
    │  Bridge    │   │  Bridge    │   │   Bridge   │
    └────────────┘   └────────────┘   └────────────┘
```

Cada Bridge implementa:
1. **Lexer**: Texto → Tokens
2. **Parser**: Tokens → GreenNode
3. **Metadata extractor**: GreenNode → RedNode con metadatos

**Los exportadores (Visitors) son agnósticos al formato de entrada.** Un documento BBCode puede exportarse a Markdown sin cambiar nada en el pipeline.

---

## 45. API Pública (index.ts)

El archivo `src/index.ts` exporta 52 símbolos públicos. Aquí están agrupados por categoría:

### Model & Core
- `DocumentModel`, `BBCodeDocumentModel`, `HTMLDocumentModel`, `MarkdownDocumentModel`

### Syntax Trees
- `GreenNode`, `greenNode`, `greenLeaf`, `RedNode`
- `TreeBuilder`, `NodeMatcher`

### Lexer & Parser
- `Lexer`, `scanBBCode`, `parseBBCode`, `parseTokensToGreen`

### Types
- `DocumentNode`, `NodeKind`, `NodeAttributes`, `NodeMetadata`, `DocumentChangeEvent`
- `Token`, `TokenKind`, `Trivia`, `TriviaKind`
- `Diagnostic`, `DiagnosticSeverity`, `DiagnosticTag`
- `Operation` (13 tipos)
- `Query`, `QueryMatch`, `QueryResult`
- `SymbolInfo`, `SymbolKind`, `Reference`, `SymbolSearchResult`

### Visitors (Exporters)
- `Visitor`, `HTMLRenderer`, `BBCodeExporter`, `MarkdownExporter`, `JSONExporter`
- `SVGRenderer`, `TiptapExporter`
- `morphHTML`, `domToSVG`

### Commands & Transactions
- `CommandRegistry`, `Transaction`, `UndoManager`
- `InsertText`, `DeleteNode`, `WrapInTag`, `SplitNode`, `MergeNode`

### Queries & Analysis
- `QueryEngine`, `SemanticAnalyzer`, `Linter`, `Formatter`, `SymbolTable`

### Render Pipeline
- `RenderPipeline`, `RenderTree`

### Plugins
- `PluginAPI`, `PluginRegistry`

### Transformers
- `applyGradient`, `applyGrow`, `applyRainbow`, `applyCentralGradient`, `applyMultiGradient`, `applyEffect`
- `RainbowTransformer`, `GradientTransformer`, `GrowTransformer`, `SineWaveTransformer`, `ASTOptimizer`

### Utilities
- `TagRegistry`, `NodeFactory`, `IncrementalParser`, `ChangeTracker`, `TreeDiffer`
- `visualThemes`, `BBCodeGenerator`, `BBCodeExporter`

### BBCode Helpers
- `bbBlocksToRedTree`, `bbBlocksToGreenTree`, `bbBlockToGreenNode`, `greenToRedNode`
- `tagToNodeKind`, `nodeKindToTag`, `isBlockKind`

---

## 46. Pruebas y Cobertura

### Archivos de Test

| Archivo | Lo que prueba |
|---------|---------------|
| `Syntax/__tests__/GreenNode.test.ts` | Creación de nodos, inmutabilidad, hijos |
| `Syntax/__tests__/RedNode.test.ts` | Creación, navegación, mutación, mutation lock |
| `Diff/__tests__/TreeDiffer.test.ts` | Detección de moves, updates, inserts/deletes |
| `Incremental/__tests__/IncrementalParser.test.ts` | Re-parseo incremental preservando bloques no afectados |

### Patrones de Test

Los tests usan `vitest` con el setup `vitest.setup.ts` (vacío). Ejemplo de patrón de test:

```typescript
describe('RedNode', () => {
  it('supports tree navigation', () => {
    const rootGreen = greenNode('Root', '', 0, 5)
    const childGreen = greenLeaf('Text', 'hello', 0, 5)
    const root = new RedNode(rootGreen)
    const child = new RedNode(childGreen)
    
    RedNode.allowMutation(() => {
      root.appendChild(child)
    })
    
    expect(child.parent).toBe(root)
    expect(root.childCount).toBe(1)
    expect(child.root).toBe(root)
    expect(child.depth).toBe(1)
  })
})
```

### Testing Mutation Lock

El test más importante verifica que las mutaciones fuera de `allowMutation()` lancen error:

```typescript
expect(() => {
  root.appendChild(child)  // Sin allowMutation
}).toThrow(/transaction boundary/)
```

---

## 47. Diagrama Completo de Dependencias

```
                          ┌───────────┐
                          │   Types   │ ← Tipos base (core, tokens, diagnostics, etc.)
                          └─────┬─────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
    ┌─────▼──────┐       ┌─────▼──────┐       ┌─────▼──────┐
    │   Lexer    │       │   Syntax   │       │   Utils    │
    │ (Tokens)   │───►───│(Green/Red) │       │(color,etc) │
    └────────────┘       └─────┬──────┘       └────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
    ┌─────▼──────┐      ┌─────▼──────┐      ┌─────▼──────┐
    │   Parser   │      │  Visitors  │      │ Diff/Tree  │
    │(BBCode/MD) │      │(Exporters) │      │  Differ    │
    └─────┬──────┘      └────────────┘      └────────────┘
          │
    ┌─────▼──────────┐
    │  DocumentModel  │ ← Orquestador Central
    │                 │
    │  ┌─ TagRegistry │
    │  ├─ NodeFactory │
    │  ├─ QueryEngine │
    │  ├─ EventBus    │
    │  ├─ UndoManager │
    │  ├─ Incremental │
    │  ├─ Semantic    │
    │  └─ NodeMatcher │
    └─────┬───────────┘
          │
    ┌─────▼──────────┐
    │  RenderPipeline │
    └─────┬───────────┘
          │
    ┌─────▼──────┐
    │   HTML/    │
    │ SVG/JSON   │
    └────────────┘
```

---

## 48. Análisis Crítico: Fortalezas y Debilidades

### Fortalezas

1. **Arquitectura Red-Green Tree**: Implementación rigurosa de un patrón probado en compiladores industriales (Roslyn, SwiftSyntax). Esto le da a Quasar una base teórica sólida.

2. **Cero dependencias en runtime**: El `package.json` solo tiene TypeScript como devDependency. Esto lo hace portable a cualquier runtime (Node, browser, Bun, Deno).

3. **Parseo Incremental**: Con presupuestos de <0.15ms, es viable para edición en tiempo real incluso en documentos grandes.

4. **Multi-formato nativo**: BBCode + HTML + Markdown + JSON + SVG + Tiptap. No es un parser de un solo formato.

5. **Round-tripping**: La preservación de trivia y la arquitectura Visitor permiten ir y volver entre formatos sin pérdida.

6. **Mutation Lock en RedNode**: Previene bugs difíciles de encontrar al forzar que todas las mutaciones pasen por `allowMutation()`.

7. **Sistema de plugins completo**: Manifest, contributions, activate/deactivate lifecycle.

8. **Efectos de TextStudio**: El sistema de capas y transformadores permite efectos visuales complejos (gradientes, ondas, arcoíris, curvas RGB) sin modificar el parser.

### Debilidades y Áreas de Mejora

1. **Commands con implementaciones stub**: `InsertText`, `DeleteNode`, `WrapInTag`, `SplitNode`, `MergeNode` son placeholders que devuelven `{ success: true }`. La lógica real de edición no está implementada.

2. **Formatter minimalista**: Solo extrae texto plano. No formatea BBCode real con indentación.

3. **Doble implementación de efectos**: Existen tanto en `Utils/treeTransformers.ts` (funcional) como en `Transformers/` (OOP). Esto duplica lógica y puede llevar a inconsistencias.

4. **BBCodeGenerator es un generador de datos de prueba**, no parte del pipeline real. No debería confundirse con el BBCodeExporter.

5. **HTMLRenderer acoplado a clases CSS específicas**: `bbcode-sp`, `bbcode-para`, `bbcode-preview`. Idealmente esto debería ser configurable.

6. **Markdown bridge incompleto**: El parser Markdown cubre lo básico pero no tiene el mismo nivel de robustez que el parser BBCode.

7. **Sin integración con Monaco Editor**: La integración real está en los módulos fuera de Quasar (MiliastryNovaFeatures). Quasar proporciona la API pero no la conexión.

8. **GreenNodePool no se usa en el pipeline principal**: Está implementado pero las funciones de creación (`greenNode`, `greenLeaf`) no lo usan automáticamente. Habría que integrarlo explícitamente.

9. **Test coverage bajo**: Solo 4 archivos de test para más de 40 módulos. Áreas críticas como `DocumentModel`, `BBCodeParser`, `HTMLRenderer` no tienen tests.

---

## 49. Guía de Contribución

### Cómo agregar un nuevo formato de entrada (Bridge)

```typescript
// 1. Crea tu lexer
function scanMyFormat(source: string): MyToken[]

// 2. Crea tu parser
function parseMyFormat(tokens: MyToken[], source: string): GreenNode

// 3. Crea tu DocumentModel
class MyFormatDocumentModel extends DocumentModel {
  protected parseToGreen(source: string): GreenNode {
    const tokens = scanMyFormat(source)
    return parseMyFormat(tokens, source)
  }
  protected buildRedFromGreen(green: GreenNode): RedNode {
    return myGreenToRedNode(green)
  }
}

// 4. ¡Exporta usando los Visitors existentes!
const model = new MyFormatDocumentModel({ source })
const html = new HTMLRenderer().render(model.redRoot!)
```

### Cómo agregar un nuevo Exportador

```typescript
class MyFormatExporter extends Visitor<string> {
  visit(node: RedNode): string {
    // Implementa tu lógica de exportación
    switch (node.kind) {
      case 'text': return node.text
      case 'bold': return `**${this.visitChildren(node)}**`
      // ...
    }
  }
}
```

### Cómo agregar un Plugin

```typescript
const pluginAPI = new PluginAPI(model)

pluginAPI.registerPlugin(
  { name: 'my-plugin', version: '1.0.0' },
  {
    tags: [
      { name: 'blur', kind: 'custom', label: 'Blur',
        isInline: true, isSelfClosing: false, canHaveChildren: true,
        toHTML: (ctx) => `<span style="filter:blur(2px)">${ctx.visitChildren(ctx.node)}</span>`,
      }
    ],
    lintRules: [
      { code: 'no-blur', severity: 'warning', 
        description: 'Blur effect is not accessible',
        validate: (node) => { /* ... */ }
      }
    ]
  }
)
```

### Cómo agregar un Transformer

```typescript
class MyTransformer implements Transformer {
  transform(document: DocumentModel): TransformResult {
    if (!document.redRoot) return { document }
    
    const operations: Operation[] = []
    // Walk the tree, create operations
    // ...
    
    const transaction = new Transaction(operations)
    transaction.apply(document.redRoot)
    return { document, transaction }
  }
}
```

---

## 50. Glosario

| Término | Definición |
|---------|------------|
| **AST** | Abstract Syntax Tree — representación jerárquica del documento |
| **Bridge** | Adaptador que convierte un formato externo (BBCode, HTML, MD) al GreenNode interno |
| **Diagnostic** | Mensaje de error, warning o hint asociado a un nodo |
| **Exporter** (o Visitor) | Recorre el RedNode tree y produce output (HTML, BBCode, JSON, etc.) |
| **Full Width** | Ancho total de un nodo incluyendo trivia (espacios, newlines) |
| **GreenNode** | Nodo inmutable del árbol sintáctico — la representación "compilada" |
| **Mutation Lock** | Mecanismo que previene mutaciones accidentales de RedNode fuera de transacciones |
| **NodeMatch** | Correspondencia entre nodos viejos y nuevos después de un re-parse |
| **RedNode** | Fachada mutable que envuelve GreenNode con IDs, padres y versión |
| **Round-tripping** | Capacidad de convertir texto → AST → texto sin pérdida de información |
| **Safe Boundary** | Nodo que sirve como límite para el re-parseo incremental (quote, box, list) |
| **Structural Sharing** | Dos subárboles idénticos comparten la misma referencia de GreenNode en RAM |
| **Syntax Stack** | Pila que usa el parser para rastrear tags abiertos y auto-cerrar los mal anidados |
| **Transaction** | Grupo atómico de operaciones que puede ser deshecho/rehecho |
| **Trivia** | Caracteres sin significado semántico pero esenciales para round-tripping (espacios, newlines) |
| **Validator** | Función que inspecciona un nodo y produce diagnósticos |

---

> *Este documento fue generado mediante análisis estructural del código fuente de Quasar. Cada afirmación está respaldada por la implementación real en `packages/quasar/src/`. Para la referencia más actualizada, consulta los archivos fuente directamente.*
>
> *Quasar es software libre bajo licencia MIT. Copyright (c) 2026 hxovc.*
