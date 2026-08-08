import { DocumentModel } from '../Model/DocumentModel'
import { Transaction } from '../Transactions/Transaction'

export interface TransformResult {
  document: DocumentModel
  transaction?: Transaction
}

export interface Transformer {
  /**
   * Transforms a DocumentModel.
   * Should ideally return a Transaction that contains the operations applied.
   */
  transform(document: DocumentModel): TransformResult
}

/**
 * Helper to apply a transformer.
 */
export function applyTransformer(document: DocumentModel, transformer: Transformer): TransformResult {
  return transformer.transform(document)
}
