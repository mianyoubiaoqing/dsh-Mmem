import {
  applyMemoryArchiveMaintenance,
  inspectMemoryArchive,
  planMemoryArchiveMaintenance,
  rehearseMemoryArchiveRollback,
} from '../packages/memory/src/maintenance.js'
import { parseMemoryKind, parseMemoryScopeV1 } from '../packages/memory/src/domain.js'

function usage(): never {
  throw new Error(
    'usage: pnpm memory:maintenance -- inspect <archive> | '
    + 'plan-migrate <archive> <owner-id> <authority> <scope-json> <memory-kind> [backup] | '
    + 'plan-recover <archive> [backup] | '
    + 'apply <archive> <token> <expected-digest> | '
    + 'rehearse-rollback <archive> <backup> <expected-backup-digest>',
  )
}

const [command, archivePath, ...rest] = process.argv.slice(2)
if (command === undefined || archivePath === undefined) usage()

let result: unknown
if (command === 'inspect') {
  if (rest.length !== 0) usage()
  result = await inspectMemoryArchive({ path: archivePath })
} else if (command === 'plan-migrate') {
  if (rest.length < 4 || rest.length > 5) usage()
  let scope: unknown
  try {
    scope = JSON.parse(rest[2]!) as unknown
  } catch {
    throw new Error('scope-json must be valid JSON')
  }
  result = await planMemoryArchiveMaintenance({
    path: archivePath,
    action: 'migrate-v1',
    backupPath: rest[4],
    scopeMigration: {
      ownerId: rest[0]!,
      authority: rest[1]!,
      scope: parseMemoryScopeV1(scope),
      memoryKind: parseMemoryKind(rest[3]),
      recordedAtPolicy: 'legacy-created-at',
    },
  })
} else if (command === 'plan-recover') {
  if (rest.length > 1) usage()
  result = await planMemoryArchiveMaintenance({
    path: archivePath,
    action: 'recover-trailing',
    backupPath: rest[0],
  })
} else if (command === 'apply') {
  if (rest.length !== 2) usage()
  result = await applyMemoryArchiveMaintenance({
    path: archivePath,
    token: rest[0]!,
    expectedDigest: rest[1]!,
  })
} else if (command === 'rehearse-rollback') {
  if (rest.length !== 2) usage()
  result = await rehearseMemoryArchiveRollback({
    path: archivePath,
    backupPath: rest[0]!,
    expectedBackupDigest: rest[1]!,
  })
} else {
  usage()
}

process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
