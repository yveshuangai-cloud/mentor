import { describe, expect, it } from 'vitest'
import { validateKnowledgeUpload } from '../src/modules/knowledge.js'

describe('knowledge portal upload validation', () => {
  it('defaults an ordinary PDF to permanent private reference knowledge', () => {
    expect(validateKnowledgeUpload({ fileName: '組織管理.pdf', sizeBytes: 1024 })).toMatchObject({
      fileName: '組織管理.pdf',
      knowledgeType: 'reference',
      retentionPolicy: 'permanent',
      visibility: 'private',
    })
  })

  it.each(['doc', 'ppt', 'xls', 'exe', 'zip'])('rejects unsupported or legacy .%s files', (extension) => {
    expect(() => validateKnowledgeUpload({ fileName: `old.${extension}`, sizeBytes: 1024 }))
      .toThrow('unsupported_document_type')
  })

  it('rejects files over the configured limit', () => {
    expect(() => validateKnowledgeUpload({
      fileName: 'huge.pdf',
      sizeBytes: 20 * 1024 * 1024 + 1,
    })).toThrow('file_too_large')
  })

  it('rejects invented lifecycle values', () => {
    expect(() => validateKnowledgeUpload({
      fileName: 'notes.md',
      sizeBytes: 20,
      retentionPolicy: 'forever-ish',
    })).toThrow('invalid_retention_policy')
  })
})
