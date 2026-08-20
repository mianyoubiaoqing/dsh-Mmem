import type { MemoryAccessContextV1, MemoryKind } from './domain.js'
import { parseMemoryKind, validateMemoryValidity } from './domain.js'
import type { CompanionMemoryArchive, MemoryCandidate, MemoryVisibility } from './contracts.js'

/** One authenticated Owner message selected as candidate-extraction evidence. */
export interface CandidateExtractionEvidenceV1 {
  readonly messageId: string
  readonly text: string
}

/** Narrow provider request; it intentionally excludes Persona, recall, and transcript history. */
export interface CandidateExtractionRequestV1 {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly turn: number
  readonly context: MemoryAccessContextV1
  readonly evidence: readonly CandidateExtractionEvidenceV1[]
}

export type CandidateExtractionReceiptV1 =
  | {
      readonly kind: 'local-deterministic'
      readonly implementationVersion: string
    }
  | {
      readonly kind: 'dsh-session'
      readonly sessionId: string
      readonly requestSeq: number
      readonly responseSeq: number
    }

/** Untrusted draft shape returned by an extraction Provider after validation. */
export interface ExtractedMemoryDraftV1 {
  readonly sourceMessageId: string
  readonly content: string
  readonly visibility: MemoryVisibility
  readonly memoryKind: MemoryKind
  readonly recordedAt?: string
  readonly validFrom?: string
  readonly validTo?: string
}

/** Canonical, bounded Provider result consumed by Memory governance. */
export interface CandidateExtractionResultV1 {
  readonly schemaVersion: 1
  readonly receipt: CandidateExtractionReceiptV1
  readonly drafts: readonly ExtractedMemoryDraftV1[]
}

/** Provider seam: implementations return data only and never receive an Archive. */
export interface CandidateExtractionProvider {
  readonly id: string
  readonly version: string
  readonly executionKind: 'local-deterministic' | 'model'
  extract(request: CandidateExtractionRequestV1, signal: AbortSignal): Promise<unknown>
}

/** Single-active-provider registry owned by the Memory plugin lifecycle. */
export class CandidateExtractionRegistry {
  #provider: CandidateExtractionProvider | undefined

  register(provider: CandidateExtractionProvider): () => void {
    nonEmpty(provider.id, 'candidate extraction provider id')
    nonEmpty(provider.version, 'candidate extraction provider version')
    if (provider.executionKind !== 'local-deterministic' && provider.executionKind !== 'model') {
      throw new TypeError('candidate extraction provider executionKind is unsupported')
    }
    if (this.#provider !== undefined) throw new Error('a candidate extraction Provider is already registered')
    this.#provider = provider
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#provider === provider) this.#provider = undefined
    }
  }

  current(): CandidateExtractionProvider | undefined {
    return this.#provider
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError('candidate extraction value contains missing or unknown fields')
  }
}

function nonEmpty(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new TypeError(`${label} must be a non-empty string no longer than ${max} characters`)
  }
  return value.trim()
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return value as number
}

/** Strictly parse the execution receipt retained with extracted candidates. */
export function parseCandidateExtractionReceiptV1(value: unknown): CandidateExtractionReceiptV1 {
  const input = record(value, 'candidate extraction receipt')
  if (input.kind === 'local-deterministic') {
    exact(input, ['kind', 'implementationVersion'])
    return { kind: 'local-deterministic', implementationVersion: nonEmpty(input.implementationVersion, 'implementationVersion') }
  }
  if (input.kind === 'dsh-session') {
    exact(input, ['kind', 'sessionId', 'requestSeq', 'responseSeq'])
    const requestSeq = integer(input.requestSeq, 'requestSeq')
    const responseSeq = integer(input.responseSeq, 'responseSeq')
    if (responseSeq <= requestSeq) throw new TypeError('responseSeq must be later than requestSeq')
    return {
      kind: 'dsh-session',
      sessionId: nonEmpty(input.sessionId, 'receipt sessionId'),
      requestSeq,
      responseSeq,
    }
  }
  throw new TypeError('candidate extraction receipt kind is unsupported')
}

function draft(value: unknown, allowedSources: ReadonlySet<string>): ExtractedMemoryDraftV1 {
  const input = record(value, 'candidate extraction draft')
  exact(input, ['sourceMessageId', 'content', 'visibility', 'memoryKind'], ['recordedAt', 'validFrom', 'validTo'])
  const sourceMessageId = nonEmpty(input.sourceMessageId, 'sourceMessageId')
  if (!allowedSources.has(sourceMessageId)) throw new TypeError('candidate draft cites evidence not selected by the host')
  if (input.visibility !== 'personal' && input.visibility !== 'confidential') {
    throw new TypeError('candidate draft visibility is unsupported')
  }
  const validity = validateMemoryValidity({
    recordedAt: input.recordedAt === undefined ? '1970-01-01T00:00:00.000Z' : nonEmpty(input.recordedAt, 'recordedAt'),
    ...(input.validFrom === undefined ? {} : { validFrom: nonEmpty(input.validFrom, 'validFrom') }),
    ...(input.validTo === undefined ? {} : { validTo: nonEmpty(input.validTo, 'validTo') }),
  })
  return {
    sourceMessageId,
    content: nonEmpty(input.content, 'candidate content', 2_000),
    visibility: input.visibility,
    memoryKind: parseMemoryKind(input.memoryKind),
    ...(input.recordedAt === undefined ? {} : { recordedAt: validity.recordedAt }),
    ...(validity.validFrom === undefined ? {} : { validFrom: validity.validFrom }),
    ...(validity.validTo === undefined ? {} : { validTo: validity.validTo }),
  }
}

/** Strictly validate a Provider response against the exact host-selected evidence set. */
export function parseCandidateExtractionResultV1(
  value: unknown,
  request: CandidateExtractionRequestV1,
): CandidateExtractionResultV1 {
  const input = record(value, 'candidate extraction result')
  exact(input, ['schemaVersion', 'receipt', 'drafts'])
  if (input.schemaVersion !== 1) throw new TypeError('candidate extraction schemaVersion must be 1')
  if (!Array.isArray(input.drafts) || input.drafts.length > 8) {
    throw new TypeError('candidate extraction drafts must be an array of at most 8 items')
  }
  const allowedSources = new Set(request.evidence.map(item => item.messageId))
  return {
    schemaVersion: 1,
    receipt: parseCandidateExtractionReceiptV1(input.receipt),
    drafts: input.drafts.map(item => draft(item, allowedSources)),
  }
}

async function providerCall(
  provider: CandidateExtractionProvider,
  request: CandidateExtractionRequestV1,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('candidate extraction timeout must be an integer from 1 through 60000')
  }
  if (signal.aborted) throw signal.reason
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', forwardAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`candidate extraction Provider timed out after ${timeoutMs}ms`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([provider.extract(request, controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', forwardAbort)
  }
}

/** Validate one Provider call and ingest each source group through the Archive consumer. */
export async function extractMemoryCandidates(
  provider: CandidateExtractionProvider,
  request: CandidateExtractionRequestV1,
  archive: CompanionMemoryArchive,
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<MemoryCandidate[]> {
  const result = parseCandidateExtractionResultV1(
    await providerCall(provider, request, options.signal, options.timeoutMs),
    request,
  )
  if (provider.executionKind === 'model' && result.receipt.kind !== 'dsh-session') {
    throw new TypeError('model candidate extraction Providers must return a DSH Session receipt')
  }
  if (provider.executionKind === 'local-deterministic' && result.receipt.kind !== 'local-deterministic') {
    throw new TypeError('local candidate extraction Providers must return a deterministic receipt')
  }
  const bySource = new Map<string, ExtractedMemoryDraftV1[]>()
  for (const draft of result.drafts) {
    const group = bySource.get(draft.sourceMessageId) ?? []
    group.push(draft)
    bySource.set(draft.sourceMessageId, group)
  }
  const candidates: MemoryCandidate[] = []
  for (const [sourceMessageId, drafts] of bySource) {
    candidates.push(...await archive.proposeExtracted({
      context: request.context,
      sourceMessageId,
      providerId: provider.id,
      providerVersion: provider.version,
      receipt: result.receipt,
      drafts: drafts.map(({ sourceMessageId: _sourceMessageId, ...draft }) => draft),
    }))
  }
  return candidates
}
