// DispatchDocs — invoice + Cargo label generation, ported from QuickShip.
// Uses DispatchLens order fields (imported invoice/contact data) instead of CSV.
// Requires window.jspdf, window.html2canvas, window.PDFLib, window.JsBarcode (CDN).

import { DBOrder } from '@/types'

const WORKER = 'https://tracklens-proxy.adityaramnani91581.workers.dev'

const SELLER_INFO = {
  company: 'SABI WABI INNOVATIONS LLP',
  addr1: 'Hissa No 1 B, Survey No.72, Rayate,',
  addr2: 'Kalyan-murbad Road, Thane,',
  addr3: 'MAHARASHTRA, 421301',
  gstin: '27AFNFS2007K1ZR',
  state: 'MH',
  currency: '₹',
  payment: '100% advance before Dispatch',
  declaration: 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
  signatory: 'Partner',
}

const INDIAN_STATE_NAMES: Record<string, string> = {
  'AN': 'Andaman & Nicobar Islands', 'AP': 'Andhra Pradesh', 'AR': 'Arunachal Pradesh',
  'AS': 'Assam', 'BR': 'Bihar', 'CH': 'Chandigarh', 'CT': 'Chhattisgarh',
  'DN': 'Dadra & Nagar Haveli and Daman & Diu', 'DL': 'Delhi', 'GA': 'Goa', 'GJ': 'Gujarat',
  'HR': 'Haryana', 'HP': 'Himachal Pradesh', 'JK': 'Jammu & Kashmir', 'JH': 'Jharkhand',
  'KA': 'Karnataka', 'KL': 'Kerala', 'LA': 'Ladakh', 'LD': 'Lakshadweep',
  'MP': 'Madhya Pradesh', 'MH': 'Maharashtra', 'MN': 'Manipur', 'ML': 'Meghalaya',
  'MZ': 'Mizoram', 'NL': 'Nagaland', 'OD': 'Odisha', 'PY': 'Puducherry', 'PB': 'Punjab',
  'RJ': 'Rajasthan', 'SK': 'Sikkim', 'TN': 'Tamil Nadu', 'TG': 'Telangana', 'TR': 'Tripura',
  'UP': 'Uttar Pradesh', 'UT': 'Uttarakhand', 'WB': 'West Bengal',
}

function getStateName(code: string): string {
  if (!code) return ''
  if (code.length > 3) return code
  return INDIAN_STATE_NAMES[code.toUpperCase()] || code
}
function fmtDate(d: string): string {
  if (!d) return ''
  const dt = new Date(d); if (isNaN(dt.getTime())) return d
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${dt.getDate()} ${m[dt.getMonth()]} ${dt.getFullYear()}`
}
function fmt(n: number): string {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function esc(s: unknown): string {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
function numberToWords(n: number): string {
  n = Math.round(n); if (n === 0) return 'Zero'
  const o = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const t = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const b = (x: number): string => x < 20 ? o[x] : x < 100 ? t[Math.floor(x / 10)] + (x % 10 ? ' ' + o[x % 10] : '') : o[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' + b(x % 100) : '')
  let r = ''
  const cr = Math.floor(n / 10000000); n %= 10000000
  const la = Math.floor(n / 100000); n %= 100000
  const th = Math.floor(n / 1000); n %= 1000
  if (cr) r += b(cr) + ' Crore '
  if (la) r += b(la) + ' Lakh '
  if (th) r += b(th) + ' Thousand '
  if (n) r += b(n)
  return r.trim()
}

// State code inference from pincode first digit isn't reliable; we use the order's
// state field if present, else fall back to MH-detection via GST columns.
function orderStateCode(o: DBOrder): string {
  if (o.state) return o.state
  // If SGST/CGST present → intrastate (MH); if IGST present → interstate (unknown state, use pincode-less).
  if ((o.sgst || 0) > 0 || (o.cgst || 0) > 0) return 'MH'
  return ''  // interstate, unknown exact state
}

export interface InvoiceOpts { signatureDataUrl?: string | null }

export function buildInvoiceHtml(o: DBOrder, opts: InvoiceOpts = {}): string {
  const qty = o.qty || 1
  const totalTaxable = +(o.taxable_value || 0)
  const totalTax = +(o.tax_amount || 0)
  const total = +((totalTaxable + totalTax).toFixed(2))

  const stateCode = orderStateCode(o)
  const stateName = getStateName(stateCode)
  // GST split: use the imported IGST/SGST/CGST directly (mutually exclusive per source).
  const igst = +(o.igst || 0)
  const cgst = +(o.cgst || 0)
  const sgst = +(o.sgst || 0)
  const isInter = igst > 0 || (cgst === 0 && sgst === 0 && stateCode !== 'MH' && stateCode !== 'MAHARASHTRA')

  const invNo = o.order_id || ''
  const invDate = fmtDate(new Date().toISOString().slice(0, 10))

  let barcodeSvg = ''
  const barcodeValue = String(invNo).trim()
  const JsBarcode = (window as unknown as { JsBarcode?: (el: Element, val: string, opts: object) => void }).JsBarcode
  if (barcodeValue && JsBarcode) {
    try {
      const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      JsBarcode(svgEl, barcodeValue, { format: 'CODE128', width: 1.4, height: 36, displayValue: false, margin: 0, background: 'transparent', lineColor: '#3d2817' })
      barcodeSvg = svgEl.outerHTML
    } catch { barcodeSvg = '' }
  }

  const addrLine = o.ship_address || ''
  const phone = o.contact_number || ''
  const unitPriceDisplay = qty > 1 ? +(((o.unit_price || total)) / qty).toFixed(2) : (o.unit_price || total)

  const itemRows = `
    <tr>
      <td style="text-align:center;padding:11px 10px;font-size:11px;color:#3d2817;border-right:1px solid #e3cfa6;border-bottom:1px solid #e3cfa6;">1</td>
      <td style="padding:11px 10px;font-size:11px;color:#3d2817;border-right:1px solid #e3cfa6;border-bottom:1px solid #e3cfa6;">
        <div style="font-weight:600;color:#3d2817;line-height:1.4;">${esc(o.sku || '')}</div>
        <div style="font-style:italic;font-size:10px;color:#8a6f55;margin-top:2px;">SKU ${esc(o.barcode_sku || o.sku || '')} · HSN 9403</div>
      </td>
      <td style="text-align:center;padding:11px 10px;font-size:11px;color:#3d2817;border-right:1px solid #e3cfa6;border-bottom:1px solid #e3cfa6;">${qty}</td>
      <td style="text-align:right;padding:11px 10px;font-size:11px;color:#3d2817;font-variant-numeric:tabular-nums;border-right:1px solid #e3cfa6;border-bottom:1px solid #e3cfa6;">${fmt(unitPriceDisplay)}</td>
      <td style="text-align:right;padding:11px 10px;font-size:11px;color:#3d2817;font-variant-numeric:tabular-nums;border-right:1px solid #e3cfa6;border-bottom:1px solid #e3cfa6;">${fmt(totalTaxable)}</td>
      <td style="text-align:right;padding:11px 10px;font-size:11px;color:#3d2817;font-variant-numeric:tabular-nums;border-bottom:1px solid #e3cfa6;">${fmt(total)}</td>
    </tr>`

  const taxLines = isInter
    ? `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 14px;border-bottom:1px solid #f3e6cc;font-size:11px;"><span style="color:#6b5340;">IGST</span><span style="font-variant-numeric:tabular-nums;color:#3d2817;font-weight:500;">${fmt(igst || totalTax)}</span></div>`
    : `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 14px;border-bottom:1px solid #f3e6cc;font-size:11px;"><span style="color:#6b5340;">CGST</span><span style="font-variant-numeric:tabular-nums;color:#3d2817;font-weight:500;">${fmt(cgst || totalTax / 2)}</span></div>
       <div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 14px;border-bottom:1px solid #f3e6cc;font-size:11px;"><span style="color:#6b5340;">SGST</span><span style="font-variant-numeric:tabular-nums;color:#3d2817;font-weight:500;">${fmt(sgst || totalTax / 2)}</span></div>`

  const awb = o.tracking_number || ''
  const awbLabel = /^[56]\d{9,}$/.test(String(awb)) ? 'TRACKING ID (BLUEDART)' : 'TRACKING ID'

  const honeycombSVG = `
    <svg style="position:absolute;top:14mm;right:14mm;width:110px;height:110px;pointer-events:none;opacity:0.55;" viewBox="0 0 110 110">
      ${[[55, 18], [82, 18], [27, 38], [55, 38], [82, 38], [27, 58], [55, 58], [82, 58]].map(([cx, cy]) => `<polygon points="${cx},${cy - 12} ${cx + 10},${cy - 6} ${cx + 10},${cy + 6} ${cx},${cy + 12} ${cx - 10},${cy + 6} ${cx - 10},${cy - 6}" fill="none" stroke="#c89548" stroke-width="1.4"/>`).join('')}
    </svg>
    <svg style="position:absolute;bottom:14mm;right:14mm;width:110px;height:110px;pointer-events:none;opacity:0.55;" viewBox="0 0 110 110">
      ${[[27, 52], [55, 52], [82, 52], [27, 72], [55, 72], [82, 72], [27, 92], [55, 92]].map(([cx, cy]) => `<polygon points="${cx},${cy - 12} ${cx + 10},${cy - 6} ${cx + 10},${cy + 6} ${cx},${cy + 12} ${cx - 10},${cy + 6} ${cx - 10},${cy - 6}" fill="none" stroke="#c89548" stroke-width="1.4"/>`).join('')}
    </svg>`

  return `
    <div style="width:210mm;min-height:297mm;padding:0;margin:0 auto;background:#fdfbf7;box-sizing:border-box;position:relative;color:#3d2817;overflow:hidden;font-family:'Inter Tight','Inter',-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5;-webkit-font-smoothing:antialiased;">
      ${honeycombSVG}
      <div style="position:relative;padding:14mm 16mm 14mm;z-index:1;">
        <div style="display:grid;grid-template-columns:1.05fr 1fr 1.1fr;gap:14px;align-items:flex-start;margin-bottom:14px;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div style="font-family:'Fraunces',Georgia,serif;font-weight:900;font-size:32px;color:#b88838;line-height:1;letter-spacing:-0.02em;">Honey Touch</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;font-size:10.5px;color:#3d2817;padding-top:4px;">
            <div style="display:flex;align-items:flex-start;gap:8px;">
              <div style="width:18px;height:18px;border-radius:50%;background:#f3e6cc;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;color:#b88838;font-size:10px;">⌖</div>
              <div style="line-height:1.4;"><strong style="display:block;font-weight:600;color:#3d2817;margin-bottom:1px;font-size:11px;">${SELLER_INFO.company}</strong>${SELLER_INFO.addr1}<br>${SELLER_INFO.addr2}<br>${SELLER_INFO.addr3}</div>
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-family:'Fraunces',Georgia,serif;font-weight:900;font-size:56px;color:#3d2817;line-height:0.9;letter-spacing:-0.04em;">INVOICE</div>
            <div style="height:2px;width:110px;background:#b88838;margin:6px 0 6px auto;position:relative;"><div style="position:absolute;width:8px;height:8px;background:#b88838;border-radius:50%;top:-3px;right:-4px;"></div></div>
            <div style="display:grid;grid-template-columns:auto 8px auto;gap:4px 8px;font-size:11px;text-align:left;justify-content:end;margin-left:auto;margin-top:8px;">
              <div style="color:#6b5340;font-weight:500;">Invoice No.</div><div style="color:#b88838;">:</div><div style="color:#3d2817;font-weight:600;">${esc(invNo)}</div>
              <div style="color:#6b5340;font-weight:500;">Invoice Date</div><div style="color:#b88838;">:</div><div style="color:#3d2817;font-weight:600;">${invDate}</div>
              <div style="color:#6b5340;font-weight:500;">Seller GSTIN</div><div style="color:#b88838;">:</div><div style="color:#3d2817;font-weight:600;">${SELLER_INFO.gstin}</div>
              <div style="color:#6b5340;font-weight:500;">Place of Supply</div><div style="color:#b88838;">:</div><div style="color:#3d2817;font-weight:600;">${esc(stateName)}</div>
            </div>
            ${barcodeSvg ? `<div style="margin-top:8px;text-align:right;">${barcodeSvg}</div>` : ''}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1.05fr 1fr;gap:18px;align-items:stretch;margin:8px 0 14px;">
          <div style="background:linear-gradient(135deg,#fbf1de 0%,#f5e2bd 100%);border-radius:12px;padding:14px 18px;position:relative;">
            <div style="position:absolute;top:14px;left:14px;width:28px;height:28px;border-radius:50%;background:#b88838;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;">👤</div>
            <div style="margin-left:38px;">
              <div style="font-size:9px;color:#b88838;letter-spacing:0.18em;font-weight:700;margin-bottom:2px;">BILL TO</div>
              <div style="font-size:14px;font-weight:700;color:#3d2817;margin-bottom:5px;">${esc(o.customer_name || '')}</div>
              <div style="font-size:10.5px;color:#3d2817;line-height:1.45;">${esc(addrLine)}</div>
              <div style="font-size:10.5px;color:#3d2817;margin-top:4px;"><span style="color:#8a6f55;font-weight:500;">State:</span> ${esc(stateName)}${phone ? '&nbsp;&nbsp;<span style="color:#8a6f55;font-weight:500;">Contact:</span> ' + esc(phone) : ''}</div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;justify-content:center;padding:8px 4px;">
            <div style="font-family:'Fraunces',cursive;font-size:24px;color:#c89548;line-height:1.2;transform:rotate(-2deg);font-style:italic;">Thank you for your business!</div>
          </div>
        </div>
        <table style="width:100%;border-collapse:separate;border-spacing:0;margin-top:4px;border-radius:6px;overflow:hidden;border:1px solid #d4b889;">
          <thead>
            <tr style="background:#c89548;">
              <th style="padding:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#fff;text-align:center;width:5%;border-right:1px solid rgba(255,255,255,0.25);">No.</th>
              <th style="padding:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#fff;text-align:left;border-right:1px solid rgba(255,255,255,0.25);">Description</th>
              <th style="padding:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#fff;text-align:center;width:7%;border-right:1px solid rgba(255,255,255,0.25);">Qty</th>
              <th style="padding:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#fff;text-align:right;width:13%;border-right:1px solid rgba(255,255,255,0.25);">Unit Price</th>
              <th style="padding:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#fff;text-align:right;width:14%;border-right:1px solid rgba(255,255,255,0.25);">Taxable</th>
              <th style="padding:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#fff;text-align:right;width:14%;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
        <div style="display:grid;grid-template-columns:1fr 0.85fr;gap:22px;margin-top:16px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;color:#b88838;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px;">
              <div style="width:22px;height:22px;border-radius:4px;background:#f3e6cc;color:#b88838;display:flex;align-items:center;justify-content:center;font-size:12px;">✉</div>
              PAYMENT METHODS
            </div>
            <div style="font-size:10.5px;color:#6b5340;margin-bottom:6px;">${SELLER_INFO.payment}</div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:#3d2817;"><div style="width:22px;height:22px;border-radius:4px;background:#f3e6cc;color:#b88838;display:flex;align-items:center;justify-content:center;font-size:11px;">⇄</div>Bank Transfer</div>
              <div style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:#3d2817;"><div style="width:22px;height:22px;border-radius:4px;background:#f3e6cc;color:#b88838;display:flex;align-items:center;justify-content:center;font-size:11px;">⌬</div>UPI</div>
            </div>
          </div>
          <div style="background:#fdfbf7;border-radius:8px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 14px;border-bottom:1px solid #f3e6cc;font-size:11px;"><span style="color:#6b5340;">Taxable Value</span><span style="font-variant-numeric:tabular-nums;color:#3d2817;font-weight:500;">${SELLER_INFO.currency} ${fmt(totalTaxable)}</span></div>
            ${taxLines}
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 14px;font-size:11px;"><span style="color:#6b5340;">Shipping</span><span style="color:#8a6f55;font-style:italic;">included</span></div>
            <div style="background:#fbe8c2;border-radius:6px;margin-top:6px;padding:14px;display:flex;justify-content:space-between;align-items:baseline;">
              <span style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;color:#3d2817;">TOTAL DUE</span>
              <span style="font-size:19px;font-weight:800;color:#3d2817;font-variant-numeric:tabular-nums;">${SELLER_INFO.currency} ${fmt(total)}</span>
            </div>
          </div>
        </div>
        <div style="margin-top:12px;padding:8px 12px;background:#fdfbf7;border-left:3px solid #c89548;font-size:10.5px;border-radius:0 4px 4px 0;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.12em;color:#b88838;margin-bottom:2px;font-weight:700;">Amount in Words</div>
          <div style="color:#3d2817;font-weight:600;">${numberToWords(Math.round(total))} only</div>
        </div>
        ${awb ? `
        <div style="margin-top:6px;padding:8px 12px;background:#fdfbf7;border-left:3px solid #c89548;font-size:10.5px;border-radius:0 4px 4px 0;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.12em;color:#b88838;margin-bottom:2px;font-weight:700;">${awbLabel}</div>
          <div style="color:#3d2817;font-weight:600;font-family:monospace;">${esc(String(awb))}</div>
        </div>` : ''}
        <div style="margin-top:14px;text-align:right;">
          <div style="font-size:10.5px;color:#6b5340;margin-bottom:4px;">For <strong style="color:#3d2817;">${SELLER_INFO.company}</strong></div>
          ${opts.signatureDataUrl ? `<img src="${opts.signatureDataUrl}" style="max-height:52px;max-width:160px;object-fit:contain;display:block;margin:0 0 0 auto;" />` : `<div style="height:52px;"></div>`}
          <div style="font-size:10.5px;color:#3d2817;font-weight:600;border-top:1px solid #d4b889;padding-top:4px;display:inline-block;min-width:140px;">${SELLER_INFO.signatory}</div>
        </div>
        <div style="margin-top:10px;font-size:11px;color:#6b5340;text-align:center;font-style:italic;">We truly appreciate your business and look forward to serving you again.</div>
      </div>
      <div style="margin-top:18px;font-size:9.5px;color:#8a6f55;line-height:1.5;text-align:center;padding:0 18mm 14mm;">${SELLER_INFO.declaration}</div>
    </div>`
}

// ── Bluedart detection: not fetchable via Cargo API ──
export function isBluedart(o: DBOrder): boolean {
  const c = (o.courier || '').toLowerCase()
  const awb = String(o.tracking_number || '')
  return c.includes('bluedart') || c === 'bd' || /^(509|685)\d/.test(awb)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = any

// ── Cargo client (via proxy) ──
function cargoHeaders(token: string): Record<string, string> {
  const isJwt = /^eyJ/.test(token)
  return { 'Content-Type': 'application/json', 'Authorization': isJwt ? ('Bearer ' + token) : ('token ' + token) }
}
async function cargoFetch(path: string, token: string): Promise<W> {
  const resp = await fetch(WORKER + '/cargo' + path, { headers: cargoHeaders(token) })
  const text = await resp.text()
  let data: W; try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!resp.ok) throw new Error('Cargo: ' + (data?.detail || data?.message || `HTTP ${resp.status}`))
  return data
}
function extractList(data: W): W[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  for (const k of ['data', 'results', 'shipments', 'items']) if (Array.isArray(data[k])) return data[k]
  if (data.data && Array.isArray(data.data.results)) return data.data.results
  return []
}
async function findShipmentByAwb(awb: string, token: string): Promise<string> {
  const today = new Date(), yearAgo = new Date(today.getTime() - 365 * 864e5)
  const fmtD = (d: Date) => d.toISOString().slice(0, 10)
  const qs = new URLSearchParams({ page: '1', page_size: '10', created_at_after: fmtD(yearAgo), created_at_before: fmtD(today), waybill_no: String(awb).trim(), entity: 'shipment' })
  const data = await cargoFetch('/shipment-list/?' + qs.toString(), token)
  const list = extractList(data)
  const fields = ['waybill_no', 'awb', 'awb_code', 'awb_number', 'tracking_number', 'awb_no', 'waybill']
  const match = list.find((s: W) => fields.some(f => String(s[f] || '').trim() === String(awb).trim())) || (list.length === 1 ? list[0] : null)
  if (match && match.id) return match.id
  throw new Error(`No Cargo shipment for AWB ${awb}`)
}
async function getLabelUrl(awb: string, token: string): Promise<string> {
  const shipmentId = await findShipmentByAwb(awb, token)
  const detail = await cargoFetch(`/shipment-detail/${encodeURIComponent(shipmentId)}/?entity=shipment`, token)
  const cands = [detail.label_url, detail.shipping_label_url, detail.awb_label, detail.label, detail.download_url, detail.shipping_label, detail.data?.label_url, detail.data?.shipping_label_url].filter(Boolean)
  if (!cands.length) { const m = JSON.stringify(detail).match(/"(https:[^"]+\.pdf[^"]*)"/); if (m) cands.push(m[1]) }
  if (!cands.length) throw new Error('No label URL in shipment detail')
  return cands[0]
}
export async function fetchLabelBytes(awb: string, token: string): Promise<Uint8Array> {
  const labelUrl = await getLabelUrl(awb, token)
  let dl: string
  if (labelUrl.startsWith('https://api-cargo.shiprocket.in/')) {
    dl = WORKER + '/cargo' + labelUrl.replace(/^https:\/\/api-cargo\.shiprocket\.in\/api/, '')
  } else {
    dl = WORKER + '/cargo/common/download_file?code=' + encodeURIComponent(labelUrl)
  }
  const isJwt = /^eyJ/.test(token)
  const resp = await fetch(dl, { headers: { 'Authorization': isJwt ? ('Bearer ' + token) : ('token ' + token) } })
  if (!resp.ok) throw new Error(`Label HTTP ${resp.status}`)
  return new Uint8Array(await resp.arrayBuffer())
}
// Strip the last page (Shiprocket ad page).
export async function stripAdPage(bytes: Uint8Array): Promise<Uint8Array> {
  const PDFLib = (window as W).PDFLib
  if (!PDFLib) return bytes
  const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })
  const n = src.getPageCount()
  if (n <= 1) return bytes
  const out = await PDFLib.PDFDocument.create()
  const pages = await out.copyPages(src, Array.from({ length: n - 1 }, (_, i) => i))
  pages.forEach((p: W) => out.addPage(p))
  return await out.save()
}

// ── Invoice PDF from HTML (html2canvas + jsPDF) → bytes ──
export async function invoicePdfBytes(o: DBOrder, opts: InvoiceOpts = {}): Promise<Uint8Array> {
  const w = window as W
  if (!w.jspdf) throw new Error('jsPDF not loaded')
  if (!w.html2canvas) throw new Error('html2canvas not loaded')
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;top:0;left:-99999px;z-index:-1;background:white;'
  container.innerHTML = buildInvoiceHtml(o, opts)
  document.body.appendChild(container)
  await (document as W).fonts.ready
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  try {
    const pageEl = container.firstElementChild as HTMLElement
    const canvas = await w.html2canvas(pageEl, { scale: 2, useCORS: true, backgroundColor: '#fdfbf7', logging: false, windowWidth: pageEl.scrollWidth, windowHeight: pageEl.scrollHeight })
    const { jsPDF } = w.jspdf
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
    const pdfW = 210, pdfH = 297
    const imgH = (canvas.height * pdfW) / canvas.width
    if (imgH <= pdfH + 10) {
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pdfW, Math.min(imgH, pdfH))
    } else {
      const pxPerMm = canvas.width / pdfW
      const sliceH = Math.floor(pdfH * pxPerMm)
      const slices = Math.ceil(canvas.height / sliceH)
      for (let i = 0; i < slices; i++) {
        const sy = i * sliceH, sh = Math.min(sliceH, canvas.height - sy)
        const sc = document.createElement('canvas'); sc.width = canvas.width; sc.height = sh
        const ctx = sc.getContext('2d')!; ctx.fillStyle = '#fdfbf7'; ctx.fillRect(0, 0, sc.width, sc.height)
        ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh)
        if (i > 0) pdf.addPage()
        pdf.addImage(sc.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pdfW, sh / pxPerMm)
      }
    }
    return new Uint8Array(await pdf.output('blob').arrayBuffer())
  } finally {
    document.body.removeChild(container)
  }
}

// ── Merge many PDF byte-arrays into one ──
export async function mergePdfs(list: Uint8Array[]): Promise<Uint8Array> {
  const PDFLib = (window as W).PDFLib
  const out = await PDFLib.PDFDocument.create()
  for (const bytes of list) {
    try {
      const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })
      const pages = await out.copyPages(src, src.getPageIndices())
      pages.forEach((p: W) => out.addPage(p))
    } catch { /* skip bad pdf */ }
  }
  return await out.save()
}

export function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
