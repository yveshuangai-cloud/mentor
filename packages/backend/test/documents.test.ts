import { describe, expect, it } from 'vitest'
import {
  documentSupport,
  extractDocument,
  extractExcelEntries,
  extractPowerPointXml,
  extractWordXml,
} from '../src/modules/documents.js'

describe('document support', () => {
  it.each(['report.pdf', 'notes.md', 'book.docx', 'deck.pptx', 'data.xlsx', 'table.csv'])(
    'accepts %s',
    (name) => expect(documentSupport(name)).toBe('supported'),
  )

  it.each(['old.doc', 'old.ppt', 'old.xls'])(
    'recognizes legacy Office file %s',
    (name) => expect(documentSupport(name)).toBe('legacy'),
  )

  it('rejects executable and unknown files', () => {
    expect(documentSupport('payload.exe')).toBe('unsupported')
    expect(documentSupport('no-extension')).toBe('unsupported')
  })
})

describe('document text extraction', () => {
  it('extracts Markdown text and hashes the source', async () => {
    const result = await extractDocument(Buffer.from('# 標題\n\n這是內容。'), 'notes.md')
    expect(result.text).toContain('這是內容')
    expect(result.fileType).toBe('md')
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.truncated).toBe(false)
  })

  it('extracts Word paragraphs, tabs and entities', () => {
    const xml = '<w:document><w:p><w:r><w:t>甲&amp;乙</w:t></w:r><w:tab/><w:r><w:t>丙</w:t></w:r></w:p></w:document>'
    expect(extractWordXml(xml)).toBe('甲&乙\t丙\n')
  })

  it('extracts PowerPoint text by paragraph', () => {
    const xml = '<p:sld><a:p><a:r><a:t>第一頁</a:t></a:r></a:p><a:p><a:r><a:t>重點</a:t></a:r></a:p></p:sld>'
    expect(extractPowerPointXml(xml)).toBe('第一頁\n重點\n')
  })

  it('extracts Excel shared strings, formulas and booleans', () => {
    const entries = new Map([
      ['xl/sharedStrings.xml', '<sst><si><t>營收</t></si></sst>'],
      ['xl/worksheets/sheet1.xml', '<worksheet><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(B2:B3)</f><v>30</v></c><c r="C1" t="b"><v>1</v></c></worksheet>'],
    ])
    const result = extractExcelEntries(entries)
    expect(result).toContain('A1=營收')
    expect(result).toContain('B1=[公式 SUM(B2:B3)] 30')
    expect(result).toContain('C1=TRUE')
  })

  it('rejects XML entity declarations', () => {
    expect(() => extractWordXml('<!DOCTYPE x [<!ENTITY bad "x">]><w:t>&bad;</w:t>')).toThrow(
      'XML 實體宣告',
    )
  })

  it('truncates very large extracted documents', async () => {
    const result = await extractDocument(Buffer.from('甲'.repeat(70_000)), 'large.txt')
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThan(61_000)
    expect(result.text).toContain('文件中段因長度限制省略')
  })
})
