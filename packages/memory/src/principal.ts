import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Owner identity and authenticated channel authority accepted by Memory. */
export interface MemoryPrincipalV1 {
  readonly ownerId: string
  readonly authority: string
}

/**
 * Resolves immutable DSH evidence into a Memory principal.
 * Undefined is the fail-closed result for missing, delegated, stale, or unsupported evidence.
 */
export interface MemoryPrincipalResolverV1 {
  message(agent: Agent, message: UserMessage): MemoryPrincipalV1 | undefined
  currentTurn(agent: Agent): MemoryPrincipalV1 | undefined
  trustedLocal(): MemoryPrincipalV1 | undefined
}

/** Current loopback DSH Host authority recorded in Memory audit context. */
export const LOCAL_DSH_MEMORY_AUTHORITY = 'local-dsh-host-rpc'

/** Configuration for the local single-Owner DSH Adapter. */
export interface LocalDshMemoryPrincipalConfigV1 {
  readonly ownerId: string
}

function rpcIdOf(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const rpcId = (source as Record<string, unknown>)['rpcId']
  return typeof rpcId === 'string' && rpcId.trim() !== '' ? rpcId : undefined
}

/** Resolves the public local DSH Host message and turn facts used by the bundled Adapter. */
export class LocalDshMemoryPrincipalResolver implements MemoryPrincipalResolverV1 {
  readonly #principal: MemoryPrincipalV1

  constructor(config: LocalDshMemoryPrincipalConfigV1) {
    if (config.ownerId.trim() === '') throw new TypeError('Memory principal ownerId must be non-empty')
    this.#principal = Object.freeze({
      ownerId: config.ownerId,
      authority: LOCAL_DSH_MEMORY_AUTHORITY,
    })
  }

  message(agent: Agent, message: UserMessage): MemoryPrincipalV1 | undefined {
    if ((agent.session.header.delegationDepth ?? 0) !== 0
      || message.source.kind !== 'user'
      || rpcIdOf(message.source) === undefined) return undefined
    return this.#principal
  }

  currentTurn(agent: Agent): MemoryPrincipalV1 | undefined {
    const events = agent.session.events
    let start = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'turn/end') return undefined
      if (event?.type === 'turn/start') {
        start = index + 1
        break
      }
    }
    if (start < 0) return undefined
    for (let index = start; index < events.length; index += 1) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const principal = this.message(agent, event.data)
      if (principal !== undefined) return principal
    }
    return undefined
  }

  trustedLocal(): MemoryPrincipalV1 {
    return this.#principal
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated Owner resolver used by every Memory read and mutation path. */
    dshMmemPrincipalResolver: MemoryPrincipalResolverV1
  }
}
