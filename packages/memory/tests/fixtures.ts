import type { MemoryAccessContextV1 } from '../src/index.js'

export const PERSONAL_COMPANION_ACCESS: MemoryAccessContextV1 = {
  version: 1,
  ownerId: 'owner-fixture',
  authority: 'local-dsh-host-rpc',
  scope: { version: 1, kind: 'companion-reality' },
  channelDisclosure: 'personal-only',
  requestIntent: 'ordinary',
}

export const CONFIDENTIAL_COMPANION_ACCESS: MemoryAccessContextV1 = {
  ...PERSONAL_COMPANION_ACCESS,
  channelDisclosure: 'owner-confidential',
  requestIntent: 'explicit-confidential-recall',
}
