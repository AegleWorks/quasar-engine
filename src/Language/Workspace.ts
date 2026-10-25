/**
 * Quasar — Workspace
 *
 * A set of open documents, each with its own model and language service, plus
 * the one operation that genuinely spans documents: Fix-All at project or
 * solution scope.
 *
 * ## Why a workspace and not a document list
 *
 * `fixAllDocuments` already existed but could never be reached from the public
 * API with a scope other than `document` — `FixAllScope` names `project` and
 * `solution`, and both threw `UnimplementedError`. That is a promise the type
 * made and the engine did not keep. A workspace is the missing noun: a
 * project/solution is a set of documents, so scoping a fix to it is running the
 * existing per-document Fix-All over that set and aggregating the result.
 *
 * Keys are caller-chosen strings (`uri`, `file.milia`, a tab id). Quasar does
 * not parse them and does not own the filesystem.
 *
 * @see fixAllDocuments — the aggregation this delegates to
 * @see LanguageService — per-document answers
 */

import {
  fixAllDocuments,
} from '../Fixes/BatchFixer'
import type { BatchResult, FixAllOptions } from '../Fixes/BatchFixer'
import type { Diagnostic } from '../Types/diagnostics'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { BBCodeDocumentModelOptions } from '../BBCode/BBCodeDocumentModel'
import { LanguageService } from './LanguageService'

export interface WorkspaceDocument {
  readonly uri: string
  readonly model: BBCodeDocumentModel
  readonly service: LanguageService
}

export interface WorkspaceOptions {
  /** Options forwarded to every document the workspace opens. */
  readonly defaults?: BBCodeDocumentModelOptions
}

export interface WorkspaceFixAllOptions extends FixAllOptions {
  /**
   * `document` needs one target: `uri`, or a workspace that holds exactly one
   * document. `project`/`solution` run over every open document. Default
   * `solution`.
   */
  readonly uri?: string
}

export class Workspace {
  private readonly documents = new Map<string, WorkspaceDocument>()
  private readonly defaults: BBCodeDocumentModelOptions

  constructor(options: WorkspaceOptions = {}) {
    this.defaults = options.defaults ?? {}
  }

  /**
   * Open a document, or update the text of one that is already open.
   *
   * Opening the same URI twice returns the same model and service, which is
   * what keeps a language service's caches useful across a re-open. Passing a
   * different source applies it as an edit (incremental where possible) rather
   * than replacing the model.
   */
  open(uri: string, source = '', options: BBCodeDocumentModelOptions = {}): WorkspaceDocument {
    const existing = this.documents.get(uri)
    if (existing !== undefined) {
      if (existing.model.source !== source) existing.model.applyTextUpdate(source, 'workspace')
      return existing
    }

    const model = new BBCodeDocumentModel({
      ...this.defaults,
      ...options,
      source,
    })
    const document: WorkspaceDocument = {
      uri,
      model,
      service: new LanguageService(model),
    }
    this.documents.set(uri, document)
    return document
  }

  /**
   * Update a document's text. Opening is implicit: an update for a URI that is
   * not open creates it, which makes a watcher loop a single call.
   */
  update(uri: string, source: string, origin: string = 'workspace'): WorkspaceDocument {
    const document = this.documents.get(uri)
    if (document === undefined) return this.open(uri, source)
    if (document.model.source !== source) document.model.applyTextUpdate(source, origin)
    return document
  }

  get(uri: string): WorkspaceDocument | undefined {
    return this.documents.get(uri)
  }

  has(uri: string): boolean {
    return this.documents.has(uri)
  }

  /** Every open document, in opening order. */
  all(): readonly WorkspaceDocument[] {
    return [...this.documents.values()]
  }

  /** Close one document. Returns whether it was open. */
  close(uri: string): boolean {
    return this.documents.delete(uri)
  }

  /** Close everything and drop every cached answer. */
  dispose(): void {
    this.documents.clear()
  }

  /** The diagnostics of every open document, keyed by URI. */
  diagnostics(): ReadonlyMap<string, readonly Diagnostic[]> {
    const result = new Map<string, readonly Diagnostic[]>()
    for (const document of this.documents.values()) {
      result.set(document.uri, document.service.getDiagnostics().diagnostics)
    }
    return result
  }

  /**
   * Fix-All across the workspace.
   *
   * The returned `passes` is the deepest per-document pass count, and the first
   * cycle any document reports wins — the same aggregation `fixAllDocuments`
   * has always described. `applied` and `deferred` are sums.
   */
  fixAll(equivalenceKey: string, options: WorkspaceFixAllOptions = {}): BatchResult {
    const scope = options.scope ?? 'solution'

    if (scope === 'document') {
      const document = options.uri !== undefined
        ? this.documents.get(options.uri)
        : this.documents.size === 1
          ? this.all()[0]
          : undefined

      if (document === undefined) {
        throw new Error(
          options.uri !== undefined
            ? `Workspace.fixAll: no open document "${options.uri}"`
            : 'Workspace.fixAll: document scope needs a uri (or exactly one open document)',
        )
      }
      return document.model.fixAll(equivalenceKey, { maxPasses: options.maxPasses, scope: 'document' })
    }

    return fixAllDocuments(
      this.all().map(document => document.model.asFixAllTarget()),
      equivalenceKey,
      { maxPasses: options.maxPasses, scope },
    )
  }
}
