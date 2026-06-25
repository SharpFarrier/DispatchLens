// ============================================================
// packedLabelGenerator.ts — 50×25mm packed-unit label PDF for TE244.
// Code128 barcode of the full packed barcode + string + description.
// Uses jspdf + jsbarcode.
// ============================================================

import { jsPDF } from 'jspdf'
import JsBarcode from 'jsbarcode'

export interface LabelUnit { barcode: string; descr?: string }

const LABEL = {
  width: 50,
  height: 25,
  marginTop: 2.0,
  barcodeH: 12,
  barcodeW: 46,
  idFontPt: 8,
  descFontPt: 7,
  lineGap1: 3.3,
  lineGap2: 3.6,
  barModuleW: 1.6,
  barCanvasH: 80,
}

function barcodeDataURL(value: string) {
  const canvas = document.createElement('canvas')
  JsBarcode(canvas, value, {
    format: 'CODE128',
    width: LABEL.barModuleW,
    height: LABEL.barCanvasH,
    displayValue: false,
    margin: 0,
  })
  return canvas.toDataURL('image/png')
}

export function buildPackedLabelsPDF(units: LabelUnit[]) {
  if (!units || !units.length) throw new Error('No units to print')

  const doc = new jsPDF({ unit: 'mm', format: [LABEL.width, LABEL.height], orientation: 'landscape' })

  units.forEach((u, idx) => {
    if (idx > 0) doc.addPage([LABEL.width, LABEL.height], 'landscape')

    const img = barcodeDataURL(u.barcode)
    const bx = (LABEL.width - LABEL.barcodeW) / 2
    doc.addImage(img, 'PNG', bx, LABEL.marginTop, LABEL.barcodeW, LABEL.barcodeH)

    let y = LABEL.marginTop + LABEL.barcodeH + LABEL.lineGap1
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(LABEL.idFontPt)
    doc.text(u.barcode, LABEL.width / 2, y, { align: 'center' })

    if (u.descr) {
      y += LABEL.lineGap2
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(LABEL.descFontPt)
      let d = String(u.descr)
      if (d.length > 38) d = d.slice(0, 37) + '…'
      doc.text(d, LABEL.width / 2, y, { align: 'center' })
    }
  })

  return doc.output('blob')
}

export async function sharePackedLabelsPDF(units: LabelUnit[], filename = 'packed-labels.pdf') {
  const blob = buildPackedLabelsPDF(units)
  const file = new File([blob], filename, { type: 'application/pdf' })

  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean; share?: (d: object) => Promise<void> }
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share!({ files: [file], title: 'Packed Labels', text: `${units.length} label(s) to print` })
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled'
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'downloaded'
}
