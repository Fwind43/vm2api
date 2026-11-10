import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from '@/lib/utils'

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomUUID', () => {
  it('returns a valid v4 UUID in standard environments', () => {
    expect(randomUUID()).toMatch(UUID_V4_RE)
  })

  it('falls back to getRandomValues when crypto.randomUUID is unavailable in HTTP contexts', () => {
    const originalCrypto = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => originalCrypto.getRandomValues(arr),
    })
    try {
      const id = randomUUID()
      expect(id).toMatch(UUID_V4_RE)
      expect(randomUUID()).not.toBe(id)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
