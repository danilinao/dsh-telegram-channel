import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The browser half is a classic script for DSH's module loader: it must register
// itself under the package name and register its settings form into the
// Plugins page's `plugins.bundle.config` slot, keyed by the package name.
// This test loads it the way the loader would, with a stub React and a
// structural Cordis context, and checks the wiring without rendering.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface LoadedEntry {
  id: string
  factory: (require: (specifier: string) => unknown) => {
    inject?: string[]
    apply: (ctx: unknown) => void
  }
}

const registered: LoadedEntry[] = []
;(globalThis as any).window = {
  __ModuleLoader__: {
    load(entry: LoadedEntry) {
      registered.push(entry)
    },
  },
}

await import('../client/client.js')

test('the bundle registers itself under the package name', () => {
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-telegram-channel-ru')
})

function loadPlugin() {
  const stubReact = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (fn: unknown) => fn,
    useSyncExternalStore: () => undefined,
    useRef: () => ({ current: null }),
  }
  return registered[0].factory((specifier: string) => {
    assert.equal(specifier, 'react')
    return stubReact
  })
}

/** A structural browser-side Cordis context: just enough for `apply`. */
function fakeContext() {
  const locales: Array<{ ns: string; dicts: Record<string, Record<string, string>> }> = []
  const styles: string[] = []
  const slots: Array<{ slot: string; registration: Record<string, unknown> }> = []
  const scopes: string[] = []
  const ctx: any = {
    effect(fn: () => () => void) {
      fn()
      return () => {}
    },
    inject(_deps: string[], callback: (scoped: unknown) => void) {
      callback(ctx)
    },
    locale: {
      register(ns: string, dicts: Record<string, Record<string, string>>) {
        locales.push({ ns, dicts })
        return () => {}
      },
    },
    slots: {
      inject(slot: string, callback: () => void) {
        callback()
      },
      register(registration: Record<string, unknown>) {
        slots.push({ slot: 'plugins.bundle.config', registration })
        return () => {}
      },
    },
    configForms: {
      get(entryId: string) {
        scopes.push(entryId)
        return { getSnapshot: () => undefined, subscribe: () => () => {}, mutate: async () => false }
      },
    },
  }
  const documentStub = {
    head: {
      appendChild(node: { textContent: string }) {
        styles.push(node.textContent)
      },
    },
    createElement() {
      return {
        attributes: {} as Record<string, string>,
        textContent: '',
        setAttribute(name: string, value: string) {
          this.attributes[name] = value
        },
        remove() {},
      }
    },
  }
  return { ctx, locales, styles, slots, scopes, documentStub }
}

test('apply registers the RU/EN dictionaries, the styles and one form slot', () => {
  const plugin = loadPlugin()
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  const { ctx, locales, styles, slots, scopes, documentStub } = fakeContext()
  const previousDocument = (globalThis as any).document
  ;(globalThis as any).document = documentStub
  try {
    plugin.apply(ctx)
  } finally {
    ;(globalThis as any).document = previousDocument
  }
  assert.equal(locales.length, 1)
  assert.equal(locales[0].ns, 'telegramChannelRu')
  assert.ok(Object.keys(locales[0].dicts.ru).length > 30)
  assert.deepEqual(Object.keys(locales[0].dicts.ru).sort(), Object.keys(locales[0].dicts.en).sort())
  assert.equal(styles.length, 1)
  assert.match(styles[0], /\.tgch-root/)

  // The form is registered into the bundle-config slot, keyed by the package
  // name — the key the Plugins page dispatches when the card is opened.
  assert.equal(slots.length, 1)
  assert.deepEqual(slots[0].registration, {
    name: 'plugins.bundle.config',
    key: 'dsh-telegram-channel-ru',
    locale: 'telegramChannelRu',
  })
  // The form edits the loader entry with the same id (id == package name here).
  assert.deepEqual(scopes, ['dsh-telegram-channel-ru'])
})

test('the package declares the browser half', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>
    files: string[]
    dsh: { client?: { platform?: string; immediately?: boolean } }
  }
  assert.equal(pkg.exports['./client'], './client/client.js')
  assert.ok(pkg.files.includes('client'))
  assert.equal(pkg.dsh.client?.platform, 'web')
  assert.equal(pkg.dsh.client?.immediately, true)
})
