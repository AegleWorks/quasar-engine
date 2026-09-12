# 3. State & Mutations (`Transactions/`)

Atomic and safe mutation pipelines operating on the `RedNode` tree.

## `Transaction`
Batches an array of atomic `Operation` primitives into a single transaction applied atomically to the `RedRoot`. If any individual operation fails, the entire transaction rolls back, preserving document structural integrity.

## `UndoManager`
Maintains undo and redo stacks, pairing committed operations with corresponding inverse mutations or text snapshots for deterministic rollbacks.
