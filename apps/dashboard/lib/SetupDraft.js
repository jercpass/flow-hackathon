// The setup draft as the owner reviews it: services, staff, hours, refunds,
// memberships. Shared by the guided salon setup (/dashboard/build) and a
// business the judge added (/dashboard/added).
import { formatMoney } from './money'

const DAY = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' }

function payText(s) {
  if (s.paymentMode === 'full_prepaid') return 'Paid in full when booking'
  if (s.paymentMode === 'deposit_percent') return `${s.depositPercent || 25}% deposit when booking`
  if (s.paymentMode === 'deposit_fixed') return `${formatMoney(s.depositAmount || 0)} deposit when booking`
  return Number(s.price) > 0 ? 'Paid in full when booking' : 'Free'
}

function daysText(days = []) {
  if (days.length === 7) return 'every day'
  return days.map(d => DAY[d] || d).join(', ')
}

function refundRows(tiers = []) {
  const sorted = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore)
  const positive = sorted.filter(t => t.hoursBefore > 0)
  const smallest = positive.length ? positive[positive.length - 1].hoursBefore : 0
  return sorted.map(t => ({
    when: t.hoursBefore > 0 ? `${t.hoursBefore}+ hours before` : `Less than ${smallest} hours before`,
    back: t.refundPct === 100 ? 'Full refund' : t.refundPct === 0 ? 'No refund' : `${t.refundPct}% back`
  }))
}

export default function Draft({ c }) {
  return (
    <div className="draft">
      <div className="draft-block">
        <div className="draft-label">Services</div>
        <table className="draft-table">
          <tbody>
            {c.services.map(s => (
              <tr key={s.name}><td><b>{s.name}</b></td><td>{s.duration} min</td><td>{formatMoney(s.price)}</td><td className="muted">{payText(s)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="draft-cols">
        <div className="draft-block">
          <div className="draft-label">Staff</div>
          {c.staff.map(p => <div key={p.name} className="draft-line"><b>{p.name}</b> · {p.services.join(', ') || 'all services'}</div>)}
        </div>
        <div className="draft-block">
          <div className="draft-label">Hours</div>
          {c.hours ? <div className="draft-line">{c.hours.open}–{c.hours.close}, {daysText(c.hours.workingDays)}</div> : <div className="muted">Not set</div>}
        </div>
      </div>
      <div className="draft-block">
        <div className="draft-label">Refunds when a customer cancels</div>
        {c.refundTiers?.length
          ? refundRows(c.refundTiers).map(r => <div key={r.when} className="draft-line draft-refund"><span>{r.when}</span><b>{r.back}</b></div>)
          : <div className="muted small">None found in the documents (the standard rules will be used).</div>}
        {c.cancellation && <div className="muted small" style={{ marginTop: 6 }}>“{c.cancellation}”</div>}
      </div>
      {c.memberships?.length > 0 && (
        <div className="draft-block">
          <div className="draft-label">Memberships and packs (paid with PayPal)</div>
          {c.memberships.map(p => (
            <div key={p.name} className="draft-line draft-refund">
              <span><b>{p.name}</b> · {p.includes}{p.discount ? `, ${p.discount}` : ''}</span>
              <b>{p.price}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
