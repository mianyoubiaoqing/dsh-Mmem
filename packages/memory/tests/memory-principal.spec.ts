import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { LocalDshMemoryPrincipalResolver } from '../src/principal.js'

function agentWithDepth(depth?: number): Agent {
  const id = SessionId(`memory-principal-${String(depth ?? 0)}`)
  const session = Session.create(id, [], {
    version: 0,
    id,
    createdAt: 1,
    ...(depth === undefined ? {} : { origin: 'subagent' as const, delegationDepth: depth }),
  })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'running',
    ctx: new Context(),
    followup() {},
    steer() {},
    inject() {},
    send: async () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function hostMessage(id: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'neutral owner input' }],
    source: { kind: 'user', rpcId: id } as UserMessage['source'],
  })
}

describe('MemoryPrincipalResolverV1 local DSH Adapter', () => {
  it('resolves only current top-level DSH Host Owner evidence', () => {
    const resolver = new LocalDshMemoryPrincipalResolver({ ownerId: 'owner-fixture' })
    const topLevel = agentWithDepth()
    const child = agentWithDepth(1)
    const message = hostMessage('rpc-owner')

    expect(resolver.message(topLevel, message)).toEqual({
      ownerId: 'owner-fixture',
      authority: 'local-dsh-host-rpc',
    })
    expect(resolver.message(child, message)).toBeUndefined()

    topLevel.session.append('turn/start', { turn: 1 })
    topLevel.session.append('user/message', message, { surfaceOp: 'append' })
    expect(resolver.currentTurn(topLevel)).toEqual({
      ownerId: 'owner-fixture',
      authority: 'local-dsh-host-rpc',
    })
    topLevel.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(resolver.currentTurn(topLevel)).toBeUndefined()
  })
})
