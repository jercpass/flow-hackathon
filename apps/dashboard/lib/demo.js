// Demo session helpers (hackathon). The session token lives in a first-party
// cookie (bp_demo) so a returning visitor gets the same session; the owner token
// goes in flow_token so the Business side uses the normal dashboard pages.
import { API } from './api'

const COOKIE = 'bp_demo'

export function getDemoToken() {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(/(?:^|; )bp_demo=([^;]+)/)
  return m ? m[1] : null
}

export function hasDemoSession() {
  return !!getDemoToken()
}

export function saveDemoSession(res) {
  const maxAge = Math.max(60, Math.floor((res.msLeft || 86_400_000) / 1000))
  document.cookie = `${COOKIE}=${res.sessionToken}; path=/; max-age=${maxAge}; SameSite=Lax`
  document.cookie = `flow_token=${res.ownerToken}; path=/; max-age=${maxAge}; SameSite=Lax`
  forgetLocal()
}

// Per-session things kept in the browser (chat, tour, script progress, which business the owner side shows).
function forgetLocal() {
  try { for (const k of ['bp_chat', 'bp_tour', 'bp_tour_pending', 'bp_script', 'bp_script_hidden', 'bp_owner_biz']) localStorage.removeItem(k) } catch {}
}

// The business the Business side is showing: null means the session's own salon.
export function ownerBusinessId() {
  try { return localStorage.getItem('bp_owner_biz') || null } catch { return null }
}

// Switch the Business side to another business in the session:
// a dashboard token for it replaces flow_token, so every dashboard page shows that business.
export async function switchOwner(businessId) {
  const r = await demoApi('/owner', { method: 'POST', body: { businessId } })
  if (!r?.ownerToken) return r || { error: 'Could not switch business.' }
  adoptOwnerToken(r.ownerToken, businessId)
  return r
}

// Run the Business side as this business from now on (switching, or a business just added).
export function adoptOwnerToken(token, businessId) {
  document.cookie = `flow_token=${token}; path=/; max-age=86400; SameSite=Lax`
  try { localStorage.setItem('bp_owner_biz', businessId) } catch {}
}

export function clearDemoSession() {
  document.cookie = `${COOKIE}=; path=/; max-age=0`
  document.cookie = 'flow_token=; path=/; max-age=0'
  forgetLocal()
}

// Never throws (same contract as api()). An ended session sends the visitor home.
export async function demoApi(path, options = {}) {
  const token = getDemoToken()
  let res
  try {
    res = await fetch(`${API}/demo${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined
    })
  } catch {
    return { error: 'Could not reach the server. Check your connection and try again.' }
  }
  if (res.status === 401 && token) {
    clearDemoSession()
    if (typeof window !== 'undefined') window.location.href = '/?ended=1'
    return null
  }
  try { return await res.json() } catch { return { error: `Unexpected server response (${res.status})` } }
}

export async function publicApi(path) {
  try {
    const res = await fetch(`${API}${path}`)
    return await res.json()
  } catch {
    return null
  }
}

export function timeLeft(ms) {
  if (ms <= 0) return 'ended'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}
