'use client'
import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]

export default function Settings() {
  const [settings, setSettings] = useState(null)
  const [saved, setSaved] = useState(false)
  const [holidayInput, setHolidayInput] = useState('')

  useEffect(() => {
    api('/dashboard/settings').then(s => {
      s.availability = s.availability || {}
      s.availability.open = s.availability.open || '09:00'
      s.availability.close = s.availability.close || '18:00'
      s.availability.workingDays = s.availability.workingDays || ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      s.availability.holidays = s.availability.holidays || []
      s.availability.advanceDays = s.availability.advanceDays ?? 30
      s.availability.minNoticeHours = s.availability.minNoticeHours ?? 1
      setSettings(s)
    })
  }, [])

  function setAvail(patch) {
    setSettings({ ...settings, availability: { ...settings.availability, ...patch } })
  }

  function toggleDay(key) {
    const days = settings.availability.workingDays || []
    setAvail({ workingDays: days.includes(key) ? days.filter(d => d !== key) : [...days, key] })
  }

  function addHoliday() {
    if (!holidayInput) return
    const hs = settings.availability.holidays || []
    if (!hs.includes(holidayInput)) setAvail({ holidays: [...hs, holidayInput].sort() })
    setHolidayInput('')
  }

  async function save(e) {
    e.preventDefault()
    await api('/dashboard/settings', { method: 'PATCH', body: settings })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!settings) return <p className="muted">Loading…</p>
  const a = settings.availability

  return (
    <div>
      <h1>Settings</h1>
      <p className="page-lead">Your business details, opening hours and booking rules. The assistant only offers times inside these.</p>
      <form onSubmit={save}>

        <div className="card">
          <h2>Business</h2>
          <div className="form-group" style={{ marginTop: 12 }}>
            <label>Business name</label>
            <input value={settings.name || ''} onChange={e => setSettings({ ...settings, name: e.target.value })} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Owner phone</label>
              <input value={settings.ownerPhone || ''} onChange={e => setSettings({ ...settings, ownerPhone: e.target.value })} />
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Opening hours</h2>
          <div className="form-row" style={{ marginTop: 12 }}>
            <div className="form-group">
              <label>Opens</label>
              <input type="time" value={a.open} onChange={e => setAvail({ open: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Closes</label>
              <input type="time" value={a.close} onChange={e => setAvail({ close: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <span className="field-label">Open on</span>
            <div className="chips">
              {DAYS.map(([key, label]) => (
                <button type="button" key={key} onClick={() => toggleDay(key)} className={`chip-toggle ${a.workingDays.includes(key) ? 'on' : ''}`}>{label}</button>
              ))}
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="check">
              <input type="checkbox" checked={!!a.break}
                onChange={e => setAvail({ break: e.target.checked ? { start: '13:00', end: '14:00' } : null })} />
              Lunch break (no bookings during this window)
            </label>
            {a.break && (
              <div className="form-row" style={{ marginTop: 10 }}>
                <div><span className="field-label">From</span><input type="time" value={a.break.start} onChange={e => setAvail({ break: { ...a.break, start: e.target.value } })} /></div>
                <div><span className="field-label">To</span><input type="time" value={a.break.end} onChange={e => setAvail({ break: { ...a.break, end: e.target.value } })} /></div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h2>Booking window</h2>
          <div className="form-row" style={{ marginTop: 12 }}>
            <div className="form-group">
              <label>Book up to (days ahead)</label>
              <input type="number" min="1" value={a.advanceDays} onChange={e => setAvail({ advanceDays: Number(e.target.value) })} />
            </div>
            <div className="form-group">
              <label>Minimum notice (hours)</label>
              <input type="number" min="0" value={a.minNoticeHours} onChange={e => setAvail({ minNoticeHours: Number(e.target.value) })} />
            </div>
          </div>
          <div className="form-group">
            <label>Closed dates</label>
            <div className="inline-form">
              <input type="date" value={holidayInput} onChange={e => setHolidayInput(e.target.value)} />
              <button type="button" className="btn-secondary" onClick={addHoliday}>Add</button>
            </div>
            {a.holidays.length > 0 && (
              <div className="chips" style={{ marginTop: 10 }}>
                {a.holidays.map(d => (
                  <span key={d} className="tag">{d}
                    <button type="button" aria-label={`Remove ${d}`} onClick={() => setAvail({ holidays: a.holidays.filter(h => h !== d) })}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="check">
              <input type="checkbox" checked={!!settings.bookingLimits}
                onChange={e => setSettings({ ...settings, bookingLimits: e.target.checked ? { period: 'week', max: 10 } : null })} />
              Cap how many bookings I take (handy for solo businesses)
            </label>
            {settings.bookingLimits && (
              <div className="form-row" style={{ marginTop: 10, maxWidth: 360 }}>
                <input type="number" min="1" value={settings.bookingLimits.max}
                  onChange={e => setSettings({ ...settings, bookingLimits: { ...settings.bookingLimits, max: Number(e.target.value) } })} />
                <select value={settings.bookingLimits.period}
                  onChange={e => setSettings({ ...settings, bookingLimits: { ...settings.bookingLimits, period: e.target.value } })}>
                  <option value="day">per day</option>
                  <option value="week">per week</option>
                  <option value="month">per month</option>
                </select>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h2>Assistant</h2>
          <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
            <label>Tone</label>
            <select value={settings.ai_config?.tone || 'friendly and concise'} onChange={e => setSettings({ ...settings, ai_config: { ...settings.ai_config, tone: e.target.value } })}>
              <option value="friendly and concise">Friendly and concise</option>
              <option value="professional">Professional</option>
              <option value="casual">Casual</option>
              <option value="formal">Formal</option>
            </select>
            <p className="field-hint">How the assistant talks to your customers on every channel. Takes effect after you save.</p>
          </div>
        </div>

        <div className="card">
          <h2>Privacy</h2>
          <p className="field-hint" style={{ marginTop: 8 }}>Flow&apos;s own AI never sees your customers&apos; names: it works with tokens like ⟦pii:K7QX2M9P⟧, and the real name is shown only to you and to the customer. Under the hood shows tokens too.</p>
          <label className="checkbox-row" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
            <input type="checkbox" checked={!!settings.ai_config?.hideCustomerNamesFromOwnerAi}
              onChange={e => setSettings({ ...settings, ai_config: { ...settings.ai_config, hideCustomerNamesFromOwnerAi: e.target.checked } })} />
            <span><b>Hide customer names from my own AI</b><br /><span className="field-hint">When you run Flow from ChatGPT, Claude or another AI app, it gets tokens instead of names. Off by default: your own AI sees real names, as you asked it to help you.</span></span>
          </label>
        </div>

        <div className="save-bar">
          <button type="submit">Save settings</button>
          {saved && <span className="saved">Saved</span>}
        </div>
      </form>
    </div>
  )
}
