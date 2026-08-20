import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import * as IdentityPlugin from '../src/index.js'
import { DshOwnerEligibilityService } from '../src/index.js'

function hostMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${text}` } as UserMessage['source'],
  })
}

function plainUserMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function agentWithDepth(depth?: number): Agent {
  const id = SessionId(`identity-agent-${String(depth ?? 0)}`)
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

function appendTurnMessage(agent: Agent, turn: number, message: UserMessage): void {
  agent.session.append('turn/start', { turn })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
}

describe('DshOwnerEligibilityService', () => {
  it('accepts DSH Host RPC messages only on a top-level Session', () => {
    const service = new DshOwnerEligibilityService({ ownerId: 'owner-fixture' })
    const topLevel = agentWithDepth()
    const child = agentWithDepth(1)
    const message = hostMessage('owner')

    expect(service.evaluateMessage(topLevel, message)).toMatchObject({ eligible: true })
    expect(service.evaluateMessage(child, message)).toEqual({
      version: 1,
      eligible: false,
      reason: 'delegated-session',
    })
    expect(service.evaluateMessage(topLevel, plainUserMessage('delegated-shape'))).toEqual({
      version: 1,
      eligible: false,
      reason: 'identity-missing',
    })
  })

  it('returns only eligible Owner messages from one proposed DSH batch', () => {
    const service = new DshOwnerEligibilityService({ ownerId: 'owner-fixture' })
    const owner = hostMessage('owner')
    const unproved = plainUserMessage('unproved')

    expect(service.ownerMessages(agentWithDepth(), [unproved, owner])).toEqual([owner])
    expect(service.ownerMessages(agentWithDepth(1), [owner])).toEqual([])
  })

  it('authorizes tools from an eligible Owner message in the active turn', () => {
    const service = new DshOwnerEligibilityService({ ownerId: 'owner-fixture' })
    const agent = agentWithDepth()
    appendTurnMessage(agent, 1, hostMessage('current-owner'))

    expect(service.evaluateCurrentTurn(agent)).toMatchObject({
      version: 1,
      eligible: true,
      ownerId: 'owner-fixture',
    })
  })

  it('does not inherit Owner evidence from an ended or previous turn', () => {
    const service = new DshOwnerEligibilityService({ ownerId: 'owner-fixture' })
    const agent = agentWithDepth()
    appendTurnMessage(agent, 1, hostMessage('past-owner'))
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(service.evaluateCurrentTurn(agent)).toEqual({
      version: 1,
      eligible: false,
      reason: 'no-active-owner-turn',
    })

    appendTurnMessage(agent, 2, plainUserMessage('unproved-current-input'))
    expect(service.evaluateCurrentTurn(agent)).toEqual({
      version: 1,
      eligible: false,
      reason: 'no-active-owner-turn',
    })
  })

  it('provides one shared Owner Eligibility service through Cordis', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })

    expect(ctx.mistymoonOwnerEligibility).toBeInstanceOf(DshOwnerEligibilityService)

    await fiber.dispose()
  })
})
