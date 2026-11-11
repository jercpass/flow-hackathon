'use client'

// Small cells shared by the owner's AG Grid tables (lib/Grid.js).

/** A main line and a muted second line, like the old two-line table cells. */
export function TwoLines({ a, b }) {
  return <div className="grid-two"><div className="grid-a">{a}</div>{b ? <div className="grid-b">{b}</div> : null}</div>
}
