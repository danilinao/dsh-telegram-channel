import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package name is dsh-telegram-channel-ru', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-telegram-channel-ru')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('имя плагина совпадает с именем пакета', () => {
  // Cordis-плагин объявляет `export const name`, и именно это имя DSH пишет в
  // профиль как `id` строки плагина. Разъехавшиеся имена ломают id-оверрайд
  // (конфиг с токеном перестаёт применяться), поэтому сверяем их тестом.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const declared = /export const name = '([^']+)'/.exec(src)
  assert.ok(declared, 'src/index.ts должен объявлять export const name')
  assert.equal(declared[1], pkg.name)

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`id: ${pkg.name}\\n\\s+name: ${pkg.name}\\n?$`))
})
