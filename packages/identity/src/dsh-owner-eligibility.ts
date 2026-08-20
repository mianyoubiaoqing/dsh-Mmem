import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { OwnerEligibilityDecisionV1, OwnerIdentityEvidenceV1 } from './contracts.js'
import { OwnerEligibilityPolicy } from './owner-eligibility-policy.js'

/** Current local DSH Web authority recorded in eligibility decisions. */
export const LOCAL_DSH_HOST_RPC_AUTHORITY = 'local-dsh-host-rpc'

/** Deployment identity used by the DSH Host RPC adapter. */
export interface DshOwnerEligibilityConfig {
  readonly ownerId: string
}

const NO_ACTIVE_OWNER_TURN: OwnerEligibilityDecisionV1 = Object.freeze({
  version: 1,
  eligible: false,
  reason: 'no-active-owner-turn',
})

function rpcIdOf(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const rpcId = (source as Record<string, unknown>)['rpcId']
  return typeof rpcId === 'string' && rpcId.trim() !== '' ? rpcId : undefined
}

/** Adapts immutable DSH Session/message facts to the shared pure policy. */
export class DshOwnerEligibilityService {
  readonly #ownerId: string
  readonly #policy: OwnerEligibilityPolicy

  constructor(config: DshOwnerEligibilityConfig) {
    this.#ownerId = config.ownerId
    this.#policy = new OwnerEligibilityPolicy({
      version: 1,
      ownerId: config.ownerId,
      authorityAllowlist: [LOCAL_DSH_HOST_RPC_AUTHORITY],
    })
  }

  /** Deployment-owned identity for trusted loopback governance adapters. */
  trustedLocalOwner(): { readonly ownerId: string; readonly authority: typeof LOCAL_DSH_HOST_RPC_AUTHORITY } {
    return { ownerId: this.#ownerId, authority: LOCAL_DSH_HOST_RPC_AUTHORITY }
  }

  /** Evaluates one proposed or durable DSH user-role message. */
  evaluateMessage(agent: Agent, message: UserMessage): OwnerEligibilityDecisionV1 {
    const rpcId = rpcIdOf(message.source)
    const sessionId = String(agent.id)
    const messageId = String(message.id)
    const identity: OwnerIdentityEvidenceV1 | undefined = rpcId === undefined
      ? undefined
      : {
          version: 1,
          authority: LOCAL_DSH_HOST_RPC_AUTHORITY,
          authenticatedOwnerId: this.#ownerId,
          sessionOwnerId: this.#ownerId,
          sessionId,
          messageId,
        }
    return this.#policy.evaluate({
      version: 1,
      sourceKind: message.source.kind,
      delegationDepth: agent.session.header.delegationDepth ?? 0,
      sessionId,
      messageId,
      identity,
    })
  }

  /** Selects messages proven to be Owner input without duplicating adapter facts in callers. */
  ownerMessages(agent: Agent, messages: readonly UserMessage[]): UserMessage[] {
    return messages.filter((message) => this.evaluateMessage(agent, message).eligible)
  }

  /** Authorizes governance only from durable Owner evidence in the latest open turn. */
  evaluateCurrentTurn(agent: Agent): OwnerEligibilityDecisionV1 {
    const events = agent.session.events
    let turnStartIndex = -1
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type === 'turn/end') return NO_ACTIVE_OWNER_TURN
      if (event?.type === 'turn/start') {
        turnStartIndex = index
        break
      }
    }
    if (turnStartIndex < 0) return NO_ACTIVE_OWNER_TURN
    for (let index = turnStartIndex + 1; index < events.length; index++) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const decision = this.evaluateMessage(agent, event.data)
      if (decision.eligible) return decision
    }
    return NO_ACTIVE_OWNER_TURN
  }
}
