'use client'
import { forwardRef } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community'

// AG Grid Community (MIT) for the owner's tables: Bookings and the PayPal ledger.
// Registered once; the theme follows
// Flow's look (font, border, radius, the blue accent).
ModuleRegistry.registerModules([AllCommunityModule])

export const gridTheme = themeQuartz.withParams({
  fontFamily: 'inherit',
  fontSize: 13.5,
  accentColor: '#2563eb',
  borderColor: '#e5e7eb',
  headerBackgroundColor: '#f9fafb',
  headerTextColor: '#6b7280',
  headerFontWeight: 600,
  wrapperBorderRadius: 12,
  rowHoverColor: '#f5f8ff',
  spacing: 7
})

/** AgGridReact with Flow's defaults: sortable, filterable, resizable columns. */
const Grid = forwardRef(function Grid({ defaultColDef, ...props }, ref) {
  return (
    <AgGridReact
      ref={ref}
      theme={gridTheme}
      animateRows
      suppressCellFocus
      {...props}
      defaultColDef={{ sortable: true, filter: true, resizable: true, minWidth: 90, ...defaultColDef }}
    />
  )
})
export default Grid
