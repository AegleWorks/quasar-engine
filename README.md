<div align="center">
  <h1>🌌 Quasar Document Engine</h1>
  <p><strong>Compiler-grade AST infrastructure for real-time document editing.</strong></p>
</div>

---

> Traditional BBCode or Markdown parsers rely on brittle Regex that destroy user formatting, collapse on invalid syntax, and freeze the UI on large documents. **Quasar is different.**

Quasar is the official document engine powering **Miliastry Nova**. It brings the architectural patterns used by modern language compilers (like C#'s *Roslyn* and Apple's *SwiftSyntax*) directly into the browser and desktop using pure TypeScript.

Instead of translating strings to HTML, Quasar builds a living, immutable **Red-Green Syntax Tree**. It parses documents incrementally in microseconds, guarantees perfect round-tripping (preserving every single space and newline), and allows for real-time visual editing at 140 FPS.

## ✨ The Core Philosophy

- 🌳 **Red-Green Syntax Tree**: An immutable, flyweight `GreenNode` core for structural sharing and memory deduplication, paired with a stateful `RedNode` facade for UI binding and cursor tracking.
- ⚡ **Incremental Parsing**: When a user types a single character in a 50KB document, Quasar only re-parses the affected span. Average mutation latency: `< 0.15ms`.
- 🛡️ **Error-Tolerant by Design**: The parser never crashes. Invalid syntax, unclosed tags, or malformed attributes simply produce `ErrorNodes` with diagnostics, keeping the rest of the AST intact.
- 🔄 **Perfect Round-Tripping**: "Trivia" (spaces, newlines, raw formatting) is strictly preserved. What the user types is exactly what is saved.
- 🔌 **Agnostic & Multi-Format**: While heavily optimized for BBCode, Quasar's Bridges support ingestion and emission of HTML, Markdown, and JSON ASTs.
- 📦 **Zero Runtime Dependencies**: Pure TypeScript. Runs natively in the Browser, Node.js, Deno, Bun, or Tauri.

## 🚀 Installation

```bash
npm install github:hxovc/Miliastry-Quasar#main
```

*(Note: Quasar is currently distributed as a git submodule for Miliastry Nova)*

## 📚 Documentation & Architecture

Quasar's internal architecture is highly advanced. If you want to understand how the parser pipeline works, how memory deduplication is achieved, or how to build AST transformers, start here:

- [**Naked Architecture (QuasarArch.MD)**](./QuasarArch.MD): Deep forensic analysis of the internal architecture, parsing pipeline, and modules.
- [**Roadmap (QuasarRoadmap.MD)**](./QuasarRoadmap.MD): Current and future state of the engine.
- [**Collaboration (QuasarCollab.MD)**](./QuasarCollab.MD): Contribution guidelines.

---

## 📜 License

[**Miliastry Source License (MSL-1.0)**](LICENSE) — Copyright (c) 2026 hxovc / Miliastry Team.

Quasar is Source-Available under a custom license designed to protect the Miliastry ecosystem. You can use, modify, and distribute the engine for any project—including standard visual BBCode editors or osu! profile tools—**except** for creating a Competing Product (i.e., a direct clone of Miliastry Nova as an integrated IDE, or a competing standalone engine based on this code). The license automatically converts to a standard MIT License 2 years after each commit.
