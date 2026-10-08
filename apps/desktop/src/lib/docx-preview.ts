import { strFromU8, unzipSync } from 'fflate'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const STRICT_WORD_NS = 'http://purl.oclc.org/ooxml/wordprocessingml/main'
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024

export function isDocxPath(path: string): boolean {
  return /\.docx$/i.test(path)
}

/** Read body text only. Never execute fields, follow relationships or load external media. */
export function docxParagraphs(dataUrl: string): string[] {
  const payload = /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)?.[1]

  if (!payload || payload.length > Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4) {
    throw new Error('Invalid or oversized Word document')
  }

  const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0))

  const files = unzipSync(bytes, {
    filter: file => file.name === 'word/document.xml' && file.originalSize <= MAX_DOCUMENT_BYTES
  })

  const documentBytes = files['word/document.xml']

  if (!documentBytes || documentBytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error('Word document body is missing or oversized')
  }

  const xml = strFromU8(documentBytes)

  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('Word document contains unsupported XML declarations')
  }

  const document = new DOMParser().parseFromString(xml, 'application/xml')

  if (document.getElementsByTagName('parsererror').length) {
    throw new Error('Word document XML is invalid')
  }

  const namespace = document.documentElement.namespaceURI

  if (namespace !== WORD_NS && namespace !== STRICT_WORD_NS) {
    throw new Error('Unsupported Word document format')
  }

  const body = document.getElementsByTagNameNS(namespace, 'body')[0]

  if (!body) {
    throw new Error('Word document body is missing')
  }

  // Paragraph order includes table cells. Deleted revisions and field instructions
  // are excluded; normal hyperlinks contribute their visible text without a URL.
  return Array.from(body.getElementsByTagNameNS(namespace, 'p')).map(paragraph =>
    Array.from(paragraph.getElementsByTagNameNS(namespace, '*'))
      .filter(element => {
        let ancestor = element.parentElement

        while (ancestor && ancestor !== paragraph) {
          if (ancestor.namespaceURI === namespace && (ancestor.localName === 'del' || ancestor.localName === 'p')) {return false}
          ancestor = ancestor.parentElement
        }

        return true
      })
      .map(element => {
        if (element.localName === 't') {return element.textContent || ''}

        if (element.localName === 'tab') {return '\t'}

        if (element.localName === 'br' || element.localName === 'cr') {return '\n'}

        return ''
      }).join(''))
}
