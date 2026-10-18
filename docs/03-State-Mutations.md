# 3. State & Mutations (`Transactions/`)

Atomic and safe mutation pipelines operating on the `RedNode` tree.

## `Transaction`
Batches tree `Operation`s into one undoable unit. `Transaction.apply` carries out `insert_node`, `delete_node`, `replace_node` and `move_node` (`Transaction.APPLICABLE`); a transaction holding any other kind is refused before anything is touched. An operation whose target is missing throws, and `DocumentModel.transact` then rebuilds the tree from the source it still describes, so a failed transaction leaves the document as it was.

`DocumentModel.transact` exports the whole changed tree and rebuilds from that text, so the whole document comes back as canonical BBCode (`[B]` → `[b]`, `\r\n` → `\n`). Edits that must keep the author's text are written as ranges (`SurgicalEdit[]` through `applyTextUpdate`), which is what Fix-All does.

## `UndoManager`
Maintains undo and redo stacks, pairing committed operations with corresponding inverse mutations or text snapshots for deterministic rollbacks.
