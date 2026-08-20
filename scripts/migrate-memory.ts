import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  openMemoryArchive,
} from '../packages/memory/src/index.js'
import {
  migrateLegacyMemoryDatabase,
  previewLegacyMemoryDatabase,
} from '../packages/memory/src/legacy-migration.js'
import { resolvePreviewHome } from '../packages/installer/src/index.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const positional = args.filter(argument => argument !== '--apply')

if (positional.length !== 1) {
  process.stderr.write('Usage: pnpm preview:migrate-memory -- <legacy-database> [--apply]\n')
  process.stderr.write('Without --apply, the command is read-only and prints a compatibility preview.\n')
  process.exitCode = 2
} else {
  const sourcePath = positional[0]!
  if (!apply) {
    process.stdout.write(`${JSON.stringify(previewLegacyMemoryDatabase(sourcePath), null, 2)}\n`)
  } else {
    const dshHome = resolvePreviewHome({ env: process.env, platform: process.platform, homeDirectory: homedir() })
    const archive = await openMemoryArchive({ path: join(dshHome, 'mistymoon', 'memory', 'memories.jsonl') })
    const result = await migrateLegacyMemoryDatabase({ sourcePath, archive })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
}
