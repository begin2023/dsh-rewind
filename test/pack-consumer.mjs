import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = await mkdtemp(join(tmpdir(), 'dsh-rewind-consumer-'))

try {
  const packDir = join(workspace, 'pack')
  const consumerDir = join(workspace, 'consumer')
  await mkdir(packDir)
  await mkdir(consumerDir)

  const packed = JSON.parse(execFileSync('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packDir,
  ], { cwd: projectRoot, encoding: 'utf8' }))
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== 'string') {
    throw new Error('npm pack did not return one tarball')
  }
  const tarball = join(packDir, packed[0].filename)

  execFileSync('npm', ['init', '--yes'], { cwd: consumerDir, stdio: 'ignore' })
  execFileSync('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarball,
  ], { cwd: consumerDir, stdio: 'ignore' })

  const probe = [
    "import { createRequire } from 'node:module'",
    "import { existsSync, readFileSync } from 'node:fs'",
    "import { dirname, join } from 'node:path'",
    "const require = createRequire(import.meta.url)",
    "const { apply } = await import('@begin2023/dsh-rewind')",
    "if (typeof apply !== 'function') throw new Error('root apply export is missing')",
    "const main = require.resolve('@begin2023/dsh-rewind')",
    "const root = dirname(main)",
    "for (const file of ['client.js', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']) { if (!existsSync(join(root, file))) throw new Error('packed file missing: ' + file) }",
    "const client = readFileSync(join(root, 'client.js'), 'utf8')",
    "if (!client.includes('window.__ModuleLoader__')) throw new Error('client bundle is incomplete')",
    "if (!readFileSync(join(root, 'cordis.patch.yml'), 'utf8').includes('@begin2023/dsh-rewind')) throw new Error('patch metadata is incomplete')",
    "const en = JSON.parse(readFileSync(require.resolve('@begin2023/dsh-rewind/locale/en.json'), 'utf8'))",
    "if (!en || typeof en !== 'object') throw new Error('English locale export is missing')",
    "const icon = require.resolve('@begin2023/dsh-rewind/icon')",
    "if (!existsSync(icon)) throw new Error('icon export is missing')",
    "console.log('PACK CONSUMER OK')",
  ].join(String.fromCharCode(10))
  const probePath = join(consumerDir, 'probe.mjs')
  await writeFile(probePath, probe)
  execFileSync(process.execPath, [probePath], { cwd: consumerDir, stdio: 'inherit' })
} finally {
  await rm(workspace, { recursive: true, force: true })
}
