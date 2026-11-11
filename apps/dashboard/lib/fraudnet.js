// PayPal risk data (FraudNet) for the web chat: PayPal's script collects device
// data under this session's client metadata id, and the server sends the same id
// with saved-PayPal payments the customer says yes to here (lambda core/riskData).

// The fncls value is fixed by PayPal; it is how fb.js finds its parameters.
const FNCLS = 'fnparams-dede7cc5-15fd-4c75-a9f4-36c430ee3a99'

export function loadFraudNet(cfg) {
  if (typeof document === 'undefined' || !cfg?.clientMetadataId) return
  if (document.querySelector(`script[fncls="${FNCLS}"]`)) return
  const params = document.createElement('script')
  params.type = 'application/json'
  params.setAttribute('fncls', FNCLS)
  params.textContent = JSON.stringify({ f: cfg.clientMetadataId, s: cfg.source, ...(cfg.sandbox ? { sandbox: true } : {}) })
  document.body.appendChild(params)
  const fb = document.createElement('script')
  fb.src = 'https://c.paypal.com/da/r/fb.js'
  fb.async = true
  document.body.appendChild(fb)
}
