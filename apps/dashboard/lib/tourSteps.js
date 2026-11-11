// The guided demo, step by step. Each step:
//   route    page to show (the tour navigates there)
//   view     customer-side view on /demo/client (web, voice, …)
//   panel    side panel tab to open (inbox, trace, guide)
//   anchor   element the card points at (CSS selector, or a list tried in order); none = centred card
//   waitFor  tour event that completes the step (pages fire it with tourEvent);
//            Next is locked until it happens (the next steps show what it makes);
//            Back and "Explore on my own" stay available
//   who      who it helps: business, customer or both
//   finale   the closing screen: big tiles to the phone apps (lib/Tour.js, FINALE)
// Copy: what it is, then why it matters. Two short lines.

export const TOUR = [
  // ── Act 1: set the business up with AI ──
  {
    id: 'welcome', act: 'Set up', route: '/dashboard/build', who: 'business',
    title: 'You own Willow & Co., a salon in Austin',
    body: 'In about five minutes you’ll set the salon up with AI, book it as a customer, then see the booking land. The AI and PayPal sandbox are real, messages land in a Flow inbox here, and the money is fake.',
    next: 'Start'
  },
  {
    id: 'describe', act: 'Set up', route: '/dashboard/build', anchor: '[data-tour="describe"]', who: 'business',
    title: 'Describe the business in plain words',
    body: 'No forms to fill in. We wrote Willow’s description for you; change it if you like.'
  },
  {
    id: 'docs', act: 'Set up', route: '/dashboard/build', anchor: '[data-tour="docs"]', who: 'business',
    title: 'The salon’s own documents',
    body: 'The price list, team and policy become the assistant’s rules. The FAQ becomes what it knows. They’re ready to use: open one to read it.'
  },
  {
    id: 'generate', act: 'Set up', route: '/dashboard/build', anchor: '[data-tour="generate"]', who: 'business', waitFor: 'setup-generated',
    title: 'Let the AI draft the salon',
    body: 'Press Generate draft. Flow\'s AI reads the description and documents and drafts services, prices, staff, hours and refund rules. Or switch to From your own AI and let your own AI app do it over MCP.'
  },
  {
    id: 'review', act: 'Set up', route: '/dashboard/build', anchor: '[data-tour="draft"]', who: 'business', waitFor: 'setup-applied',
    title: 'The AI drafts, you approve',
    body: 'Check the draft, then press Create my salon (or approve it in your own AI). From here on, prices and refunds are worked out by code from these rules, never guessed by the AI.'
  },
  {
    id: 'learn', act: 'Set up', route: '/dashboard/build', anchor: '[data-tour="learn"]', who: 'customer', waitFor: 'setup-learned',
    title: 'Teach it the FAQ',
    body: 'See what Claude will store (the FAQ PDF becomes text, which is cheaper to read), then press Save to Claude. Claude reads the documents whole to answer customers’ questions in the salon’s own words, quoting where it found them. Try a question right after.'
  },
  {
    id: 'trace-setup', act: 'Set up', route: '/dashboard/build', panel: 'trace', anchor: '.demo-side', who: 'both',
    title: 'Under the hood, nothing hidden',
    body: 'Every step lands on this timeline: the AI draft, the refund rules, the documents indexed. Later you’ll see AI tool calls, seat holds and PayPal calls here too.'
  },
  {
    id: 'paypal', act: 'Set up', route: '/dashboard/payments', anchor: '[data-tour="paypal"]', who: 'business',
    title: 'Paid up front, through PayPal',
    body: 'Every booking is paid when it’s made, in full or as a deposit (the rest is paid with PayPal before the visit), so the people who book turn up. The money goes into the salon’s PayPal; this demo uses a PayPal sandbox account.'
  },
  {
    id: 'switch', act: 'Set up', route: '/dashboard', anchor: '.demo-switch', who: 'both',
    title: 'The salon is live. Now be the customer',
    body: 'Next you’re the customer, one of Willow’s regulars. You can switch sides any time from here.',
    next: 'Be the customer'
  },

  // ── Act 2: book as the customer ──
  {
    id: 'meet-sam', act: 'Book', route: '/demo/client', view: 'web', anchor: '[data-tour="who"]', who: 'customer', waitFor: 'customer-who',
    title: 'You’re the customer: log in with PayPal',
    body: 'Log in with PayPal to start: your own sandbox account, or the demo’s test account shown on this card (copy its email and password into PayPal’s login page). Flow books under that name everywhere. PayPal then asks once to save the account (nothing is charged): agree, and every booking pays in one click. You’ve had three haircuts at Willow with Ana and would rather text than call.'
  },
  {
    id: 'script', act: 'Book', route: '/demo/client', view: 'web', anchor: '[data-tour="script"]', who: 'customer',
    title: 'Your script',
    body: 'Each step shows exactly what to send. Press Send, or type your own message any time, in any language: Flow answers in the language you use. Voice notes are pre-recorded so you don’t have to act.'
  },
  {
    id: 'msg-usual', act: 'Book', route: '/demo/client', view: 'web', anchor: '[data-tour="script-step"]', who: 'customer', waitFor: 'script:usual',
    title: 'It knows its regulars',
    body: 'Send step 1. Flow finds your usual (a haircut with Ana) from past visits. No forms, no phone tag.'
  },
  {
    id: 'msg-time', act: 'Book', route: '/demo/client', view: 'web', anchor: '[data-tour="script-step"]', who: 'both', waitFor: 'script:time',
    title: 'Pick a time',
    body: 'Send step 2. Flow checks Ana’s calendar, holds the slot for 10 minutes and sends a PayPal button. Paying upfront cuts no-shows.'
  },
  {
    id: 'pay', act: 'Book', route: '/demo/client', view: 'web', anchor: ['[data-tour="paypal-pay"]', '[data-tour="script-step"]'], who: 'both', waitFor: 'chat-paid',
    title: 'Pay with PayPal (sandbox)',
    body: 'Press “Yes, pay with saved PayPal”. The PayPal you linked at the start pays it in one click, with no PayPal page. Before charging, Flow re-checks the seat, so nobody pays for a slot that’s gone, then issues a paid PayPal invoice. This step goes on once PayPal confirms.'
  },
  {
    id: 'voice-question', act: 'Book', route: '/demo/client', view: 'web', anchor: '[data-tour="script-step"]', who: 'customer', waitFor: 'script:chat-question',
    title: 'Customers can just talk',
    body: 'Play the voice note, read it, then send it. It’s transcribed like any voice note, and the answer comes from the salon’s own FAQ.'
  },
  {
    id: 'voice-cancel', act: 'Book', route: '/demo/client', view: 'web', anchor: '[data-tour="script-step"]', who: 'both', waitFor: 'script:confirm',
    title: 'Plans change',
    body: 'Send the cancel voice note, then “Yes, cancel it”. The refund follows the salon’s policy, worked out by code and confirmed by you first.'
  },
  {
    id: 'packs', act: 'Book', route: '/demo/client', view: 'web', anchor: '[data-tour="script-step"]', who: 'both', waitFor: 'script:packs',
    title: 'What else is on offer?',
    body: 'Send step 7. The assistant shows Willow’s monthly membership and haircut pack, both paid with PayPal. Regular income for the salon, savings for regulars.'
  },
  {
    id: 'subscribe', act: 'Book', route: '/demo/client', view: 'web', anchor: ['[data-tour="paypal-pay"]', '[data-tour="script-step"]'], who: 'both', waitFor: 'chat-subscribed',
    title: 'Join, paid from your saved PayPal',
    body: 'Send step 8, then press “Yes, pay $35 with saved PayPal”. No PayPal page: the PayPal you linked at the start pays now and each month, and you can cancel any time just by asking. This step goes on once PayPal confirms.'
  },
  {
    id: 'covered', act: 'Book', route: '/demo/client', view: 'web', anchor: '[data-tour="script-step"]', who: 'customer', waitFor: 'script:covered',
    title: 'Covered by the membership',
    body: 'Send the last step. The haircut is covered, so there’s no payment link: code checks the membership and counts the use. Colour would get the 10% member discount.'
  },
  {
    id: 'inbox', act: 'Book', route: '/demo/client', view: 'web', panel: 'inbox', anchor: '.demo-side', who: 'both',
    title: 'Inboxes, both sides',
    body: 'You get the confirmation and refund messages, each with the receipt PDF and a link to the PayPal invoice. The owner gets the same for each booking and cancellation, and the invoice shows the refund.'
  },

  // ── Act 3: the owner's side ──
  {
    id: 'owner-calendar', act: 'Owner', route: '/dashboard/calendar', view: 'week', anchor: '[data-tour="calendar"]', who: 'business',
    title: 'The owner did nothing',
    body: 'The booking and the cancellation landed on the calendar while they were busy cutting hair. Each bar shows what PayPal says: paid, deposit, refunded, a slot held while someone pays, or a dispute with its deadline. Drag a booking to move it; the customer is told.'
  },
  {
    id: 'owner-overview', act: 'Owner', route: '/dashboard', anchor: '[data-tour="impact"]', who: 'business',
    title: 'What Flow did for the salon',
    body: 'Bookings made without the owner, money paid through PayPal before the visit, and what the policy kept on no-shows. The salon’s own numbers, above the day’s bookings and takings.'
  },
  {
    id: 'owner-bookings', act: 'Owner', route: '/dashboard/bookings', anchor: '[data-tour="bookings-grid"]', who: 'business',
    title: 'Every booking, one grid',
    body: 'Sort, filter and search every booking from any channel. Refund any amount, collect the rest of a deposit, mark came or no-show, or cancel with the refund the policy gives.'
  },
  {
    id: 'owner-ledger', act: 'Owner', route: '/dashboard/payments', anchor: '.ledger', who: 'business',
    title: 'The PayPal ledger',
    body: 'Every PayPal payment and refund with its capture id and invoice, totals that follow your filters, and a CSV for the accountant.'
  },

  {
    id: 'owner-members', act: 'Owner', route: '/dashboard/memberships', anchor: '[data-tour="members"]', who: 'business',
    title: 'Money that comes back every month',
    body: 'Members and monthly recurring revenue, each member charged monthly from their saved PayPal. Plans can be created or changed here, or by asking the owner’s own AI.'
  },
  {
    id: 'owner-disputes', act: 'Owner', route: '/dashboard/disputes', anchor: '[data-tour="disputes"]', who: 'business',
    title: 'Disputes, answered from the booking',
    body: 'If a customer disputes a payment with PayPal, the booking is the evidence. Open a practice case on a paid booking and press “Draft a response with AI”: Claude writes the reply from the booking’s own record, and nothing goes to PayPal until the owner sends it.'
  },

  // ── Act 4: more ways in ──
  {
    id: 'allowance', act: 'More', route: '/demo/client', view: 'profile', anchor: '[data-tour="allowance"]', who: 'customer',
    title: 'Let your AI pay for you, within limits',
    body: 'Once your first payment has saved PayPal, turn on an AI spending allowance (say $50 a booking, $150 a month, for 30 days, at salons) and your AI pays within it without asking: in the chat, by voice or from your own AI. Flow signs the terms and writes down each payment; code checks every limit, and the AI can’t change them.'
  },
  {
    id: 'finale', act: 'Done', route: '/demo/client', who: 'both', finale: true,
    title: 'That’s Flow. Now take it with you',
    body: 'The same assistant, the same PayPal and the same bookings, in the apps you already use. Pick one: everything you do there shows up here.',
    next: 'Finish'
  }
]

// The finale's tiles: the customer-side page each one opens (/demo/client?view=…).
export const FINALE = [
  { view: 'telegram', name: 'Telegram', tag: 'Text or talk', brand: 'tg', body: 'Message Flow like a friend: text, a voice note, or a photo of the cut you want. Pay with the PayPal button it sends.', cta: 'Open Telegram setup' },
  { view: 'alexa', name: 'Alexa', tag: 'Hands-free', brand: 'alexa', body: '“Alexa, ask Flow Bookings to book me a haircut.” Add your Amazon account, say your 4-digit code, and book by voice.', cta: 'Set up Alexa' },
  { view: 'mcp', name: 'Your own AI', tag: 'Claude · ChatGPT', brand: 'ai', body: 'Connect Flow to Claude or ChatGPT once, then book and pay from their phone apps. With your allowance on, it pays within your limits.', cta: 'Connect your AI' }
]

export const WHO = { business: 'Helps the business', customer: 'Helps the customer', both: 'Helps both' }

// While the tour runs, the phone apps (Telegram, Alexa) stay locked in the
// customer menu, so the judge follows the web path; finishing the tour (its
// last card offers them) or putting it away unlocks them. lib/Tour.js sets it;
// app/demo/client reads it. No tour (explore sessions): never locked.
export const PHONE_LOCK_EVENT = 'bp-phone-lock'
export const phoneLocked = () => typeof document !== 'undefined' && document.documentElement.dataset.phoneLock === '1'
export function setPhoneLock(on) {
  if (typeof document === 'undefined' || phoneLocked() === !!on) return
  if (on) document.documentElement.dataset.phoneLock = '1'
  else delete document.documentElement.dataset.phoneLock
  window.dispatchEvent(new CustomEvent(PHONE_LOCK_EVENT, { detail: !!on }))
}

// Pages report progress with this (e.g. after the AI draft arrives). Events
// are queued in localStorage until the tour has applied them, so one fired
// while the tour isn't mounted yet (back from PayPal, page reload) still counts.
export const PENDING_KEY = 'bp_tour_pending'
export function tourEvent(name) {
  if (typeof window === 'undefined') return
  try {
    const q = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
    localStorage.setItem(PENDING_KEY, JSON.stringify([...q, name].slice(-20)))
  } catch {}
  window.dispatchEvent(new CustomEvent('bp-tour', { detail: name }))
}
