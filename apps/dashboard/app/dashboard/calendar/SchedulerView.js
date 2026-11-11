'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BryntumScheduler } from '@bryntum/scheduler-react'
import { StringHelper } from '@bryntum/scheduler'
import '@bryntum/scheduler/scheduler.css'
import '@bryntum/scheduler/svalbard-light.css'
import '@bryntum/scheduler/fontawesome/css/fontawesome.css'
import '@bryntum/scheduler/fontawesome/css/solid.css'

// Bryntum Scheduler (trial) for the owner's calendar. Staff are rows; bookings
// and blocked time are bars. Dragging a booking asks the server first
// (onBeforeEventDropFinalize + finalize) — the move only sticks if the staff
// member does that service and is free; the customer is told in their inbox.
// Times are business-local wall-clock strings from the API, so the calendar
// shows the salon's hours whatever the viewer's own time zone is.
//
// Layout: one narrow staff column (name + what they do), and the hours stretch
// to fill whatever width is left; below a minimum per hour the timeline scrolls
// instead of squashing labels together.
//
// PayPal drives the bars: a seat held while
// the customer pays is a striped "waiting for PayPal" bar that becomes the
// booking when the capture lands; deposit, refunded, reversed (PayPal took it
// back) and disputed (with its respond-by date) each have their own colour, and
// a disputed bar opens its case.

const enc = v => StringHelper.encodeHtml(v == null ? '' : String(v))
const p2 = n => String(n).padStart(2, '0')
const toLocal = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`
// How a booking first came in, as the tooltip's line; a move is shown on its own line.
const ORIGIN = { web: 'Booked via web chat', speaker: 'Booked via the voice assistant', mcp: 'Booked via an AI agent (MCP)', voice: 'Booked by phone', manual: 'Added by you', mcp_owner: 'Added by you via MCP', manual_block: 'Blocked by you', mcp_block: 'Blocked by you via MCP' }
const MOVED = { owner: 'Moved by you', customer: 'Moved by the customer' }
const minsLeft = until => Math.max(0, Math.ceil((Number(until) - Date.now()) / 60_000))
// The bar's small PayPal line, so the state reads without hovering.
const payLine = ev => {
  const pay = ev.get('pay')
  if (pay === 'held') return `Waiting for PayPal · ${minsLeft(ev.get('heldUntil'))} min`
  if (pay === 'reviewing') return 'PayPal reviewing the payment'
  if (pay === 'disputed') return `Dispute · respond by ${ev.get('disputeDue') ? new Date(ev.get('disputeDue')).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'soon'}`
  if (pay === 'reversed') return 'Reversed by PayPal'
  return null
}

const STAFF_COL = 180
// Per-hour column width: a 1-hour booking must stay a readable bar. The week
// is wider than the screen, so it scrolls sideways (and opens on its first booking).
const MIN_TICK = { day: 72, week: 64 }
const WEEK_STEP = 1

// Header rows read like a calendar: month and year on top, then the day,
// then the hours. Bryntum's own zooming is off (it drifted outside the dates on
// screen and showed random ones); Day / Week and the date picker choose what's
// shown instead.
const DAY_PRESET = {
  base: 'hourAndDay',
  timeResolution: { unit: 'minute', increment: 15 },
  // The hour row drives the range, so the day shows opening hours, not 24h.
  mainHeaderLevel: 2,
  headers: [
    { unit: 'month', dateFormat: 'MMMM YYYY', align: 'start' },
    { unit: 'day', dateFormat: 'dddd, MMMM D', align: 'start' },
    { unit: 'hour', dateFormat: 'h A' }
  ]
}
// Week view: hourly columns under each day, and only opening hours (nights are
// hidden with workingTime), so a 1-hour booking is still a readable bar.
const WEEK_PRESET = {
  base: 'hourAndDay',
  timeResolution: { unit: 'minute', increment: 15 },
  headers: [
    { unit: 'month', dateFormat: 'MMMM YYYY', align: 'start' },
    { unit: 'day', dateFormat: 'ddd D', align: 'start' },
    { unit: 'hour', increment: WEEK_STEP, dateFormat: 'h A' }
  ]
}

// Object props are defined once: the React wrapper re-applies any prop whose
// identity changes on re-render, and re-applying subGridConfigs rebuilds the
// locked grid (crash: "Id …lockedSubgrid already in use").
const SUBGRIDS = { locked: { width: STAFF_COL } }
const COLUMNS = [{
  text: 'Staff', field: 'name', width: STAFF_COL, htmlEncode: false,
  renderer: ({ record }) => `<div class="cal-staff"><b>${enc(record.name)}</b><span>${enc(record.get('services'))}</span></div>`
}]
const TOOLTIP = {
  template: ({ eventRecord, startText, endText }) => {
    const g = f => eventRecord.get(f)
    const rows = [
      g('customer') && `<div><b>${enc(g('customer'))}</b></div>`,
      `<div>${enc(startText)} – ${enc(endText)}</div>`,
      g('paid') && `<div>Paid ${enc(g('paid'))} via PayPal${g('refunded') ? ` · refunded ${enc(g('refunded'))}` : ''}</div>`,
      g('amountDue') && `<div>${enc(g('amountDue'))} due: the booking confirms when PayPal captures it</div>`,
      ...(g('paypal') || []).map(l => `<div class="bp-tip-pp">${enc(l)}</div>`),
      g('channel') && `<div>${enc(ORIGIN[g('channel')] || `Booked via ${g('channel')}`)}</div>`,
      g('moved') && `<div>${enc(MOVED[g('moved')] || 'Moved')}</div>`,
      g('notes') && `<div>📝 ${enc(g('notes'))}</div>`,
      // The reference photo the customer sent (signed link, an hour), bigger here than on the card.
      g('photos')?.length && `<div class="bp-tip-photos">${g('photos').map(u => `<img src="${enc(u)}" alt="Reference photo from the customer">`).join('')}</div>`,
      g('disputeId') ? '<div style="opacity:.7">Click to open the dispute</div>' : eventRecord.draggable ? '<div style="opacity:.7">Drag to move — the customer is told in their inbox</div>' : ''
    ].filter(Boolean)
    return `<div class="bp-tip"><div style="font-weight:600;margin-bottom:4px">${enc(eventRecord.name)}</div>${rows.join('')}</div>`
  }
}
// Service on top, customer below, then the customer's note (allergy, care
// need…), so the owner sees them without hovering. DomConfig `text` is escaped.
// A reference photo sits in the bar's bottom-right corner (a 30-minute booking
// leaves the text only a few pixels, so it can't be one more line).
const renderEvent = ({ eventRecord, renderData }) => {
  const photo = eventRecord.get('photos')?.[0]
  const pay = eventRecord.get('pay')
  if (pay === 'held' || pay === 'reviewing') renderData.cls['cal-ev-held'] = 1
  if (pay === 'disputed') renderData.cls['cal-ev-disputed'] = 1
  if (photo) {
    renderData.cls['cal-ev-has-photo'] = 1
    renderData.style = `background-image:url("${String(photo).replace(/["\\\n\r]/g, '')}")`
  }
  return {
    className: 'cal-ev',
    children: [
      { tag: 'b', text: eventRecord.name },
      eventRecord.get('customer') ? { tag: 'span', text: eventRecord.get('customer') } : null,
      payLine(eventRecord) ? { tag: 'span', className: 'cal-ev-pay', text: payLine(eventRecord) } : null,
      eventRecord.get('notes') ? { tag: 'span', className: 'cal-ev-note', text: `📝 ${eventRecord.get('notes')}` } : null
    ].filter(Boolean)
  }
}

export default function SchedulerView({ data, view, day, onMove, onOpenDispute }) {
  const box = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!box.current) return
    // Measure now (observers don't fire in background tabs), then follow resizes.
    setWidth(box.current.clientWidth)
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])

  const { startDate, endDate, ticks, workingTime } = useMemo(() => {
    const openH = Math.max(0, parseInt(data.hours.open, 10) - 1)
    const closeH = Math.min(24, parseInt(data.hours.close, 10) + 1)
    if (view === 'week') {
      // Exact opening hours (no padding), aligned to the 3-hour columns.
      const from = Math.floor(parseInt(data.hours.open, 10) / WEEK_STEP) * WEEK_STEP
      const to = Math.min(24, Math.ceil(parseInt(data.hours.close, 10) / WEEK_STEP) * WEEK_STEP)
      const s = new Date(`${day}T00:00:00`)
      const e = new Date(s); e.setDate(e.getDate() + 7)
      return { startDate: s, endDate: e, ticks: 7 * ((to - from) / WEEK_STEP), workingTime: { fromHour: from, toHour: to } }
    }
    return { startDate: new Date(`${day}T${p2(openH)}:00:00`), endDate: new Date(`${day}T${p2(closeH)}:00:00`), ticks: closeH - openH, workingTime: null }
  }, [data.hours.open, data.hours.close, view, day])   // values, not the object: a refresh must not re-apply the range

  // The page refreshes every 15 s; hand Bryntum new arrays only when something
  // actually changed, so a refresh never rebuilds or scrolls the calendar.
  const resKey = JSON.stringify(data.resources)
  const evKey = JSON.stringify(data.events)
  const resources = useMemo(() => data.resources, [resKey])   // eslint-disable-line react-hooks/exhaustive-deps
  const events = useMemo(() => data.events, [evKey])   // eslint-disable-line react-hooks/exhaustive-deps

  // Open where the action is: the week's first booking (else the start).
  // When the first booking changes (one arrives in an empty week), scroll to it.
  const firstStart = (data.events || []).filter(e => e.status !== 'blocked').map(e => e.startDate).sort()[0] || null
  // Not Bryntum's visibleDate prop: it re-scrolls on every change and crashes
  // ("o[…] is not a function" in scrollToCoordinate) when the date isn't on the
  // time axis, e.g. outside the week view's working hours. Scroll once, only to
  // a date that's on the axis, and never let a failed scroll surface.
  const sched = useRef(null)
  useEffect(() => {
    const inst = sched.current?.instance
    if (!inst || !firstStart) return
    const t = setTimeout(() => {
      if (inst.isDestroyed) return
      const date = new Date(firstStart)
      if (inst.timeAxis?.dateInAxis && !inst.timeAxis.dateInAxis(date)) return
      try { Promise.resolve(inst.scrollToDate(date, { block: 'center', animate: false })).catch(() => {}) } catch { /* stay where we are */ }
    }, 50)
    return () => clearTimeout(t)
  }, [firstStart, view, day, width > 0])   // eslint-disable-line react-hooks/exhaustive-deps

  // Fill the free width; never narrower than the minimum (then it scrolls).
  const tickSize = Math.max(MIN_TICK[view] || 72, Math.floor((width - STAFF_COL - 4) / ticks) || 0)

  return (
    <div ref={box} className="cal-host">
      {width > 0 && (
        <BryntumScheduler
          ref={sched}
          key={`${view}-${day}`}
          startDate={startDate}
          endDate={endDate}
          viewPreset={view === 'week' ? WEEK_PRESET : DAY_PRESET}
          zoomOnMouseWheel={false}
          zoomOnTimeAxisDoubleClick={false}
          {...(workingTime ? { workingTime } : {})}
          tickSize={tickSize}
          rowHeight={64}
          barMargin={8}
          eventStyle="tonal"
          subGridConfigs={SUBGRIDS}
          columns={COLUMNS}
          resources={resources}
          events={events}
          eventEditFeature={false}
          eventDragCreateFeature={false}
          eventResizeFeature={false}
          eventMenuFeature={false}
          scheduleMenuFeature={false}
          cellMenuFeature={false}
          eventRenderer={renderEvent}
          eventTooltipFeature={TOOLTIP}
          onEventClick={({ eventRecord }) => { if (eventRecord.get('disputeId')) onOpenDispute?.(eventRecord.get('disputeId')) }}
          onBeforeEventDropFinalize={({ context }) => {
            context.async = true
            const ev = context.eventRecord
            const resource = context.newResource || context.resourceRecord
            onMove({ bookingId: ev.id, startLocal: toLocal(context.startDate), resourceId: resource?.id })
              .then(ok => context.finalize(!!ok))
              .catch(() => context.finalize(false))
          }}
        />
      )}
    </div>
  )
}
