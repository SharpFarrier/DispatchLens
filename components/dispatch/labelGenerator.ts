// 50×25mm Code128 label PDF for TSC TE244 — coating/frame labels.
// Mirrors WareLens lib/labelGenerator.js. Uses jspdf + jsbarcode.
import { jsPDF } from 'jspdf'
import JsBarcode from 'jsbarcode'

export interface LabelPiece {
  barcode: string
  shape?: string | null
  size?: string | null
  colour?: string | null
  mattress?: string | null
}

const LABEL = {
  width: 50, height: 25, marginX: 3, marginTop: 2.0,
  barcodeH: 12, barcodeW: 44,
  idFontPt: 9, attrFontPt: 8, colourFontPt: 8,
  lineGap1: 3.3, lineGap2: 3.2, lineGap3: 3.0,
  barModuleW: 2, barCanvasH: 80,
}

function mattressShort(m?: string | null): string {
  if (!m) return ''
  const v = String(m).trim().toLowerCase()
  if (v === 'with mattress' || v === 'with') return 'W/ Mat'
  if (v === 'without mattress' || v === 'without') return 'No Mat'
  return String(m)
}

function barcodeDataURL(value: string): string {
  const canvas = document.createElement('canvas')
  JsBarcode(canvas, value, {
    format: 'CODE128', width: LABEL.barModuleW, height: LABEL.barCanvasH,
    displayValue: false, margin: 0,
  })
  return canvas.toDataURL('image/png')
}

export function buildLabelsPDF(pieces: LabelPiece[]): Blob {
  if (!pieces || !pieces.length) throw new Error('No pieces to print')
  const doc = new jsPDF({ unit: 'mm', format: [LABEL.width, LABEL.height], orientation: 'landscape' })

  pieces.forEach((p, idx) => {
    if (idx > 0) doc.addPage([LABEL.width, LABEL.height], 'landscape')
    const img = barcodeDataURL(p.barcode)
    const bx = (LABEL.width - LABEL.barcodeW) / 2
    doc.addImage(img, 'PNG', bx, LABEL.marginTop, LABEL.barcodeW, LABEL.barcodeH)

    let y = LABEL.marginTop + LABEL.barcodeH + LABEL.lineGap1
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(LABEL.idFontPt)
    doc.text(p.barcode, LABEL.width / 2, y, { align: 'center' })

    y += LABEL.lineGap2
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(LABEL.attrFontPt)
    const attr = [p.shape, p.size].filter(Boolean).join(' · ')
    if (attr) doc.text(attr, LABEL.width / 2, y, { align: 'center' })

    const mat = mattressShort(p.mattress)
    const colourLine = [p.colour, mat].filter(Boolean).join('  ·  ')
    if (colourLine) {
      y += LABEL.lineGap3
      doc.setFontSize(LABEL.colourFontPt)
      doc.text(colourLine, LABEL.width / 2, y, { align: 'center' })
    }
  })

  return doc.output('blob')
}

export async function shareLabelsPDF(pieces: LabelPiece[], filename = 'labels.pdf'): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = buildLabelsPDF(pieces)
  const file = new File([blob], filename, { type: 'application/pdf' })

  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Coating Labels', text: `${pieces.length} label(s) to print` })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled'
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'downloaded'
}
