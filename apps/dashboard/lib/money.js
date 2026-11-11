// Flow is USD-only. One helper so every page formats money the same way.
export function formatMoney(amount) {
  const n = Number(amount) || 0
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2
  }).format(n)
}
