import { NextResponse } from 'next/server'

// Demo only: both sides (customer /demo, owner /dashboard) need a live demo
// session started on the home page. There are no real owner logins.
// Next 16 calls this file proxy.js (it was middleware.js).
export function proxy(request) {
  const token = request.cookies.get('flow_token')?.value
  const demo = request.cookies.get('bp_demo')?.value
  const path = request.nextUrl.pathname
  if (path.startsWith('/dashboard') && !(token && demo)) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  if (path.startsWith('/demo') && !demo) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  // There's no page at /demo itself: the customer side is /demo/client.
  if (path === '/demo' || path === '/demo/') {
    return NextResponse.redirect(new URL('/demo/client', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/demo/:path*']
}
