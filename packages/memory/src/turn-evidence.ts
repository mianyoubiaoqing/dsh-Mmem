/** User-visible evidence retained temporarily for one summarized top-level DSH turn. */
export interface MemoryTurnEvidenceCapsuleV1 {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly turn: number
  readonly userMessages: readonly {
    readonly messageId: string
    readonly text: string
  }[]
  readonly assistantMessage: {
    readonly messageId: string
    readonly text: string
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted()
  const expected = [...keys].toSorted()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains missing or unknown fields`)
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new TypeError(`${label} must be a bounded non-empty string`)
  }
  return value
}

function visibleMessage(value: unknown, label: string): { messageId: string; text: string } {
  const input = object(value, label)
  exact(input, ['messageId', 'text'], label)
  return {
    messageId: text(input.messageId, `${label} messageId`, 512),
    text: text(input.text, `${label} text`, 200_000),
  }
}

/** Strictly parse untrusted persisted or host-supplied Turn Evidence. */
export function parseMemoryTurnEvidenceCapsuleV1(value: unknown): MemoryTurnEvidenceCapsuleV1 {
  const input = object(value, 'turn evidence capsule')
  exact(input, ['schemaVersion', 'sessionId', 'turn', 'userMessages', 'assistantMessage'], 'turn evidence capsule')
  if (input.schemaVersion !== 1) throw new TypeError('turn evidence schemaVersion must be 1')
  if (!Number.isSafeInteger(input.turn) || (input.turn as number) < 0) {
    throw new TypeError('turn evidence turn must be a non-negative safe integer')
  }
  if (!Array.isArray(input.userMessages) || input.userMessages.length < 1 || input.userMessages.length > 32) {
    throw new TypeError('turn evidence userMessages must contain from 1 through 32 items')
  }
  const userMessages = input.userMessages.map((message, index) => visibleMessage(message, `turn evidence user message ${index}`))
  const totalCharacters = userMessages.reduce((sum, message) => sum + message.text.length, 0)
  const assistantMessage = visibleMessage(input.assistantMessage, 'turn evidence assistant message')
  if (totalCharacters + assistantMessage.text.length > 500_000) {
    throw new TypeError('turn evidence capsule exceeds its character budget')
  }
  return {
    schemaVersion: 1,
    sessionId: text(input.sessionId, 'turn evidence sessionId', 512),
    turn: input.turn as number,
    userMessages,
    assistantMessage,
  }
}
