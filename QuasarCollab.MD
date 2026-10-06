# 🛰️ Quasar — Real-time collaboration: architecture

> Decision document, written on **2026-08-05**, before the first line of code.
> If someone proposes changing the architecture, they must first refute this document.

## The decision: text-CRDT

**The unit of synchronization is the source text, not the tree.** Each client keeps the
source in a text CRDT (Yjs/`Y.Text` or equivalent). On each client, Quasar acts as a pure
function `text → tree → view`. A remote edit enters the engine by the same path as a local
keystroke: one `TextChange` per `applyChange`.

### Why (summary of the full reasoning)

1. **Quasar's truth is already the text.** The tree is derived state: `transact` exports
   to text and reparses; everything enters through `parse`. We sync the truth and derive the rest.
2. **Total parsing absorbs any merge.** The parser produces a valid tree for
   *any* text (broken tags stay as visible text, week 4). The worst case of an
   ugly concurrent merge is literal markup on screen, which can be fixed; never structural
   corruption.
3. **Parsing is deterministic and cheap.** Validated on hundreds of thousands of documents:
   same text ⇒ same tree on every client, with nothing else to sync. The
   incremental parser (0.8 ms/keystroke) absorbs remote edits at the same cost as
   local ones.
4. **The right precedent is the code editor**, not the rich-text one: Miliastry is a
   site where people type markup by hand in Monaco. Tree-as-truth (ProseMirror) requires a
   surface where you cannot type half a tag, which is the opposite of this product.

### Why NOT tree-as-truth (for the future reader)

- Every keystroke in Monaco would have to be translated into tree operations… by parsing. You
  pay for the parse anyway, plus the burden of expressing it as ops.
- Intermediate states (`[b` half-typed) have no tree representation.
- The tree loses information on purpose (`[s]` vs `[strike]`, `centre` vs `center`):
  `tree → text` is not exact today, and making it exact requires Roslyn-style trivia on every
  node.
- Pairwise operation merging, global ids, rewritten undo.

If BBCodeCanvas ever becomes THE main surface, we revisit this. Not before.

## Division of responsibilities

| Layer | Responsible for | NOT responsible for |
|---|---|---|
| **Quasar (engine)** | position transformation through `TextChange`; `origin` on events (telling local from remote); deterministic and incremental parsing | transport, awareness, persistence, conflict resolution (the CRDT does that) |
| **CRDT (Yjs or other, app layer)** | text convergence; per-origin undo; history | knowing about the tree |
| **App (Miliastry)** | transport (WebSocket/WebRTC), presence, painted remote cursors, permissions | touching the engine |

The engine stays **dependency-free** (package.json: zero deps). Yjs lives in the app.

## Engine API for collaboration

### v0 — positions (this session) ✅

`src/Collab/positions.ts`:

- `transformOffset(offset, change, bias?)` — where a position ends up after a
  `TextChange`. `bias: 'left' | 'right'` decides the side when the edit lands exactly
  on the position (a caret wants `'right'` so that what someone else types in front of it
  pushes it; the start of a highlight usually wants `'left'`).
- `transformRange(range, change)` — both ends, never inverted.
- Both accept a **sequence** of changes (composed in order).

With this, the app can keep its own and remote carets and selections correct through
any edit, local or remote.

### v1 — origin of changes (this session) ✅

`applyChange(change, origin?)` / `applyTextUpdate(source, origin?)` — the `origin` travels in
the events (`document_changed.origin`). Without it, the sync layer cannot tell the echo
of its own changes from the user's edits (the classic infinite loop). Default:
`'local'`.

### v2 — the session (done, in the app) ✅

`MiliastryNovaFeatures/BBCode/Collab/CollabSession.ts` — the Y.Doc ↔ model binding,
**transport-agnostic** (the tests are the transport: two in-memory clients
exchanging updates). It lives in the feature, not in the engine: `yjs@13.6.32` is a dependency
of the app; the engine stays at zero. The session knows a **contract** (`CollabDocument`:
`source` + `applyTextUpdate`), not `BBCodeDocumentModel` (Law VII).

- `updateFromLocal(text)` → minimal splice into the `Y.Text` (prefix/suffix diff: the CRDT's
  merge quality depends on edits being WHERE they happened) + model with
  origin `'local'`. The observer ignores its own echo by `tx.origin`.
- Remote → observer → `applyTextUpdate(text, 'remote')`.
- Undo: `Y.UndoManager` with `trackedOrigins = [session]`. It undoes only your own changes, never
  your peer's. It reaches the model as `'local-undo'`.
- Cursors: `createCursor`/`resolveCursor` over `Y.RelativePosition`. They survive
  remote edits by pointing at the same content.
- Seeding: an empty shared text adopts the model (creating a session); a non-empty one overrides the
  model (joining). From that moment on, the CRDT is the authority.

Validated in `CollabSession.test.ts` (7 tests): text+tree+HTML convergence, concurrent
offline edits that converge, per-client undo, cursor anchoring, origins, and
`destroy` without touching the shared doc.

### v3 — what remains (transport and presence, app code)

- A real provider (y-websocket/y-webrtc) plugged into `session.doc`: one line once a
  server exists.
- Presence: awareness (`y-protocols`) + painted remote cursors —
  `resolveCursor` + `findNodeAtOffset` to highlight each person's block (stable ids
  make it cheap).
- Integration with `DocumentInstance`/Monaco: editor edits enter through
  `session.updateFromLocal` instead of going straight into the pipeline; the `'remote'` event refreshes the
  Monaco buffer without re-triggering the loop.

## What we are NOT going to build

- **Our own OT.** Convergence belongs to the CRDT. `transformOffset` transforms *positions*,
  not changes against changes.
- **Tree synchronization.** A node never travels over the network.
- **A server.** The engine does not know a network exists.
