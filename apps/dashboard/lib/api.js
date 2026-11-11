import { cleanUrl } from './env'

export const API = cleanUrl(process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:4000'

function getToken() {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(/flow_token=([^;]+)/)
  return m ? m[1] : null
}

export function setToken(token) {
  document.cookie = `flow_token=${token}; path=/; max-age=604800; SameSite=Lax`
}

export function clearToken() {
  document.cookie = 'flow_token=; path=/; max-age=0'
}

export async function api(path, options = {}) {
  const token = getToken()

  // Never throw. Callers do `setLoading(true) → await api(...) → setLoading(false)`,
  // so a rejected promise here would leave the button stuck on "Signing in..."
  // forever with nothing shown to the user.
  let res
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  } catch {
    return { error: 'Could not reach the server. Check your connection and try again.' }
  }

  // A 401 means the demo session ended (End session elsewhere, or 24h passed):
  // back to the demo home page. There are no real owner logins.
  if (res.status === 401) {
    clearToken()
    const demo = typeof document !== 'undefined' && /(^|; )bp_demo=/.test(document.cookie)
    if (demo) document.cookie = 'bp_demo=; path=/; max-age=0'
    if (typeof window !== 'undefined') window.location.href = demo ? '/?ended=1' : '/'
    return null
  }

  try {
    return await res.json()
  } catch {
    return { error: `Unexpected server response (${res.status})` }
  }
}
