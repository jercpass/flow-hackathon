import path from 'path'
import { fileURLToPath } from 'url'

const dashboardDir = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // Vercel already sets the correct project tracing root. This override is
  // only needed when building the dashboard from the local monorepo.
  ...(process.env.VERCEL === '1'
    ? {}
    : { outputFileTracingRoot: path.join(dashboardDir, '../..') }),
  // The system map is a static page in public/systemmap/index.html. Next.js
  // doesn't serve a folder's index.html by itself, so /systemmap points at it.
  async rewrites() {
    return [{ source: '/systemmap', destination: '/systemmap/index.html' }]
  },
  // Its old addresses still work.
  async redirects() {
    return [
      { source: '/system-map.html', destination: '/systemmap', permanent: true },
      { source: '/system-map', destination: '/systemmap', permanent: true },
    ]
  },
}
