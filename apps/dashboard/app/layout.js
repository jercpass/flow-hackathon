import './globals.css'
import './demo.css'
import DemoShell from './DemoShell'

// The title and description also make the preview card when the link is shared (Discord, Slack, Devpost).
export const metadata = {
  title: 'Flow: AI Agents That Book & Pay',
  description: 'Customers, or their own AI, book and pay with PayPal at any business that takes bookings. Code, not the AI, decides every dollar.',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body><DemoShell>{children}</DemoShell></body>
    </html>
  )
}
