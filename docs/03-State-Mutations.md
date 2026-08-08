# 3. State & Mutations (`Transactions/`)

Modificaciones atómicas y seguras sobre el árbol `RedNode`.

## `Transaction`
Agrupa un arreglo de primitivas `Operation` en una sola unidad atómica para ser aplicada de forma segura al `RedRoot`. Si una operación falla, todo el bloque se descarta, manteniendo la integridad estructural del documento.

## `UndoManager`
Mantiene la pila de deshacer (undo) y rehacer (redo) emparejando las operaciones ejecutadas con sus respectivos estados inversos.
