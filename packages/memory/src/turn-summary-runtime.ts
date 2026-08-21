import type { CompanionMemoryArchive, MemoryCandidate } from './contracts.js'
import type { MemoryAccessContextV1 } from './domain.js'
import type { MemoryRuntimeSettingsManagerV1 } from './runtime-settings.js'
import type { MemoryTurnEvidenceCapsuleV1 } from './turn-evidence.js'
import {
  deterministicTurnSummaryContentV1,
  type TurnSummaryCompressorV1,
} from './turn-summary-dsh.js'

export interface ProposeCompletedTurnSummaryOptionsV1 {
  readonly target: Pick<CompanionMemoryArchive, 'propose'>
  readonly settings: Pick<MemoryRuntimeSettingsManagerV1, 'getTurnSummary'>
  readonly compressor: TurnSummaryCompressorV1
  readonly spaceId: string
  readonly context: MemoryAccessContextV1
  readonly sourceMessageId: string
  readonly dshWorkspaceCwd?: string
  readonly evidence: MemoryTurnEvidenceCapsuleV1
  readonly signal: AbortSignal
}

function samePolicy(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Propose one automatic summary while keeping model output optional and policy-revision safe.
 * Every model failure or concurrent policy change degrades to the local deterministic summary.
 */
export async function proposeCompletedTurnSummaryV1(
  options: ProposeCompletedTurnSummaryOptionsV1,
): Promise<MemoryCandidate> {
  const localContent = deterministicTurnSummaryContentV1(
    options.evidence.userMessages.map(message => message.text),
    options.evidence.assistantMessage.text,
  )
  const initialPolicy = await options.settings.getTurnSummary(options.spaceId)
  let content = localContent
  let extraction: MemoryCandidate['extraction']
  if (initialPolicy.mode === 'dsh-model' && options.dshWorkspaceCwd !== undefined) {
    try {
      const compressed = await options.compressor.compress({
        schemaVersion: 1,
        sourceSessionId: options.evidence.sessionId,
        turn: options.evidence.turn,
        dshWorkspaceCwd: options.dshWorkspaceCwd,
        policyRevision: initialPolicy.revision,
        userMessages: options.evidence.userMessages,
        assistantMessage: options.evidence.assistantMessage,
        signal: options.signal,
      }, initialPolicy)
      const currentPolicy = await options.settings.getTurnSummary(options.spaceId)
      if (samePolicy(currentPolicy, initialPolicy)) {
        content = compressed.content
        extraction = compressed.extraction
      }
    } catch {
      // Automatic summary creation is more important than optional model compression.
      // Candidate reliability remains explicitly provisional in both paths.
    }
  }
  return options.target.propose({
    context: options.context,
    sourceMessageId: options.sourceMessageId,
    content,
    visibility: 'personal',
    memoryKind: 'summary',
    turnEvidence: options.evidence,
    ...(extraction === undefined ? {} : { extraction }),
  })
}
