import { cp, mkdir, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'packages', 'bundle', 'lib')

const relativeOutput = relative(root, output)
if (relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) {
  throw new Error('refusing to assemble the npm package outside the repository')
}

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

for (const name of ['identity', 'memory', 'settings-ui']) {
  await cp(
    resolve(root, 'packages', name, 'lib'),
    resolve(output, name),
    { recursive: true },
  )
}

console.log('assembled @mistymoon/dsh-mmem publication directory')
