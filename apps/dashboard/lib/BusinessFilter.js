'use client'

// "Showing: <business>" for the owner side of the panel's Inbox and Under the
// hood: one business at a time (the one you're running by default), or all.
export default function BusinessFilter({ list, value, onChange }) {
  if (!list || list.length < 2) return null
  return (
    <label className="panel-filter">
      <span>Showing</span>
      <select value={value} onChange={e => onChange(e.target.value)} aria-label="Which business to show">
        {list.map(b => <option key={b.businessId} value={b.businessId}>{b.name}</option>)}
        <option value="all">All businesses</option>
      </select>
    </label>
  )
}
