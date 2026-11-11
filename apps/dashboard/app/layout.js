import './globals.css'
import './demo.css'
import DemoShell from './DemoShell'

export const metadata = {
  title: 'Flow',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body><DemoShell>{children}</DemoShell></body>
    </html>
  )
}
