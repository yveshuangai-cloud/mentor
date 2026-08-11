import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  embedTexts: vi.fn(),
  embeddingConfigured: vi.fn(() => false),
}))

vi.mock('../src/db/tenantDb.js', () => ({
  forTenant: () => ({
    tenantId: 1,
    query: mocks.query,
    withTransaction: mocks.withTransaction,
  }),
}))

vi.mock('../src/modules/memory/vector.js', () => ({
  embedTexts: mocks.embedTexts,
  embeddingConfigured: mocks.embeddingConfigured,
}))

import {
  loadRelevantDocumentContext,
  requestsFullDocumentContext,
  saveUploadedDocument,
  type ExtractedDocument,
} from '../src/modules/documents.js'

const uploaded: ExtractedDocument = {
  fileName: 'strategy.pdf',
  fileType: 'pdf',
  text: 'same extracted content',
  truncated: false,
  sha256: 'a'.repeat(64),
}

describe('document knowledge persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.embeddingConfigured.mockReturnValue(false)
  })

  it('reuses the existing document id for the same user, visibility and content hash', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 42 }] })

    await expect(saveUploadedDocument(1, 9, uploaded)).resolves.toBe(42)

    expect(mocks.query).toHaveBeenCalledOnce()
    expect(mocks.query.mock.calls[0][0]).toContain('content_sha256 = $4')
    expect(mocks.query.mock.calls[0][1]).toEqual([9, 'private', uploaded.sha256])
    expect(mocks.withTransaction).not.toHaveBeenCalled()
    expect(mocks.embedTexts).not.toHaveBeenCalled()
  })

  it('merges every chunk in source order when the user requests the complete document', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 7, file_name: 'whole.pdf', truncated: false }] })
      .mockResolvedValueOnce({
        rows: [
          { citation: '【whole.pdf，段落 1】', content: 'first' },
          { citation: '【whole.pdf，段落 2】', content: 'second' },
          { citation: '【whole.pdf，段落 3】', content: 'third' },
        ],
      })

    const context = await loadRelevantDocumentContext(1, 9, '請完整閱讀整份文件')

    expect(context).toContain('完整文件內容：whole.pdf')
    expect(context).toContain('全部分段')
    expect(context.indexOf('first')).toBeLessThan(context.indexOf('second'))
    expect(context.indexOf('second')).toBeLessThan(context.indexOf('third'))
    expect(mocks.query.mock.calls[1][0]).toContain('ORDER BY chunk_index ASC')
    expect(mocks.embedTexts).not.toHaveBeenCalled()
  })
})

describe('full document intent', () => {
  it.each(['完整閱讀這份文件', '請通讀附件', '從頭到尾看完', '給我全文摘要', '說明全部內容'])(
    'recognizes %s',
    (message) => expect(requestsFullDocumentContext(message)).toBe(true),
  )

  it('does not expand all chunks for an ordinary semantic question', () => {
    expect(requestsFullDocumentContext('這份文件的策略重點是什麼？')).toBe(false)
  })
})
