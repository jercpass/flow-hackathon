// Kinds of business and their icons: the demo city's salons, barber and spa,
// and whatever a judge adds (backend: core/addedBusiness KINDS).
export const ICON = {
  salon: '✂️', barber: '💈', spa: '💆', nails: '💅', massage: '🤲',
  fitness: '🏋️', tattoo: '🖋️', pets: '🐾', other: '📍'
}

export const iconFor = category => ICON[category] || '📍'
