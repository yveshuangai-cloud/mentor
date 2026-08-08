import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/config.js', () => ({
  config: {
    lineChannelToken: 'test-token',
    lineChannelSecret: 'test-secret',
  },
}))

describe('LINE loading animation', () => {
  it('starts the native three-dot animation for 60 seconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const { startLoadingAnimation } = await import('../src/modules/line.js')

    await startLoadingAnimation('U-test', 99)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/chat/loading/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chatId: 'U-test', loadingSeconds: 60 }),
      }),
    )
    vi.unstubAllGlobals()
  })
})
