import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('database migration ordering', () => {
  it('uses one unique numeric prefix per migration', async () => {
    const directory = join(process.cwd(), 'src', 'db', 'migrations')
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql'))
    const byPrefix = new Map<string, string[]>()

    for (const file of files) {
      const prefix = file.match(/^(\d+)_/)?.[1]
      expect(prefix, `${file} must start with a numeric migration prefix`).toBeTruthy()
      const siblings = byPrefix.get(prefix!) ?? []
      siblings.push(file)
      byPrefix.set(prefix!, siblings)
    }

    const duplicates = [...byPrefix.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([prefix, names]) => `${prefix}: ${names.join(', ')}`)

    expect(duplicates, `duplicate migration prefixes:\n${duplicates.join('\n')}`).toEqual([])
  })
})
