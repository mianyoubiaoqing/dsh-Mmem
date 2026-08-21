import {
  applyStandaloneMemoryMigrationV1,
  applyStandaloneMemoryRollbackV1,
  planStandaloneMemoryMigrationV1,
  rehearseStandaloneMemoryRollbackV1,
} from '../packages/memory/src/standalone-migration.js'
import { parseMemoryKind, parseMemoryScopeV1 } from '../packages/memory/src/domain.js'

const [command, ...args] = process.argv.slice(2)

function usage(): never {
  process.stderr.write(
    'Usage: migrate-memory '
      + 'plan <source-sqlite> <target-archive> <owner-id> <authority> <scope-json> <memory-kind> [backup] | '
      + 'apply <token> <confirmation> <source-digest> <target-digest> | '
      + 'rehearse-rollback <rollback-token> | '
      + 'rollback <rollback-token> <confirmation>\n',
  )
  process.exit(2)
}

let result: unknown
if (command === 'plan') {
  if (args.length < 6 || args.length > 7) usage()
  result = await planStandaloneMemoryMigrationV1({
    sourcePath: args[0]!,
    targetPath: args[1]!,
    context: {
      version: 1,
      ownerId: args[2]!,
      authority: args[3]!,
      scope: parseMemoryScopeV1(JSON.parse(args[4]!) as unknown),
      channelDisclosure: 'owner-confidential',
      requestIntent: 'explicit-confidential-recall',
    },
    memoryKind: parseMemoryKind(args[5]),
    ...(args[6] === undefined ? {} : { backupPath: args[6] }),
  })
} else if (command === 'apply') {
  if (args.length !== 4) usage()
  result = await applyStandaloneMemoryMigrationV1({
    token: args[0]!,
    confirmation: args[1]!,
    expectedSourceDigest: args[2]!,
    expectedTargetDigest: args[3]!,
  })
} else if (command === 'rehearse-rollback') {
  if (args.length !== 1) usage()
  result = await rehearseStandaloneMemoryRollbackV1({ token: args[0]! })
} else if (command === 'rollback') {
  if (args.length !== 2) usage()
  result = await applyStandaloneMemoryRollbackV1({ token: args[0]!, confirmation: args[1]! })
} else {
  usage()
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
