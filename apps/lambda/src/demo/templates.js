'use strict'

// ─── Demo city: Austin, TX ────────────────────────────────────────────────────
// Four real-feeling businesses a judge can book across — two salons, a barber
// and a spa — each with a location, staff, prices, hours, a refund policy and an
// FAQ. Every demo session gets its own private copy of all four (see
// core/demoSession), so bookings never leak between judges.
//
// Willow & Co. Salon is the business the judge RUNS on the Business side (its
// copy is `demo-<sid>`); the others are `demo-<sid>-<slug>`.
// The customer persona, John Doe, lives in Travis Heights and has been to
// Willow three times with Ana — so "book my usual" has a real answer.
//
// PayPal: Willow is paid into Flow's own sandbox Business account (the one
// that owns the app), the only account PayPal lets Flow refund, invoice and
// bill memberships on without partner access (Oct 22).

const BUSINESS_ID = 'flow-demo-salon'   // used by the sandbox scripts
const TIMEZONE = 'America/Chicago'
const CITY = { name: 'Austin', center: { lat: 30.2672, lng: -97.7431 }, radiusKm: 60 }

const EVERY_DAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/**
 * The demo PayPal account: Flow's own sandbox Business account. Orders name no
 * payee (paypalMerchantId null), so the money, refunds, invoices and memberships
 * all live in the account that owns the app. Sandbox only.
 */
function demoPaypal() {
  return {
    paymentProvider: 'paypal', paypalMerchantId: null, paypalEmail: process.env.PAYPAL_PLATFORM_EMAIL || null,
    paypalDemo: true, paypalCanRefund: true, paypalReceivable: true
  }
}

/** The demo account can be used: sandbox, with Flow's PayPal app keys set. */
function demoPaypalAvailable() {
  return process.env.PAYPAL_ENV !== 'live' && !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)
}

function base(slug, overrides) {
  return {
    status: 'active',
    timezone: TIMEZONE,
    paymentProvider: 'paypal',
    channels: {},
    demoTemplate: slug,
    ...overrides,
    config: { currency: 'USD', ai_config: { tone: 'warm and concise', human_active: false }, ...overrides.config }
  }
}

const svc = (serviceId, name, duration, price, paymentMode, extra = {}) =>
  ({ serviceId, name, active: true, unitType: 'person', durationMode: 'fixed', duration, price, paymentMode, ...extra })

const CATALOG = [
  {
    slug: 'willow',
    owned: true,
    build: () => base('willow', {
      name: 'Willow & Co. Salon',
      type: 'salon',
      category: 'salon',
      location: { lat: 30.2486, lng: -97.7497, address: '1500 S Congress Ave, Austin, TX 78704', neighborhood: 'South Congress' },
      ...demoPaypal(),
      config: {
        services: [
          svc('svc-haircut', 'Haircut', 60, 40, 'full_prepaid'),
          svc('svc-color', 'Color & Gloss', 120, 120, 'deposit_percent', { depositPercent: 25 })
        ],
        staff: [
          { staffId: 'staff-ana', name: 'Ana', services: ['svc-haircut', 'svc-color'] },
          { staffId: 'staff-ben', name: 'Ben', services: ['svc-haircut'] }
        ],
        availability: { open: '09:00', close: '18:00', workingDays: EVERY_DAY, minNoticeHours: 1, advanceDays: 30 },
        policies: {
          cancellation: 'Free cancellation up to 48 hours before; 50% back from 24 hours; no refund inside 24 hours.',
          refundTiers: [{ hoursBefore: 48, refundPct: 100 }, { hoursBefore: 24, refundPct: 50 }, { hoursBefore: 0, refundPct: 0 }]
        },
        faq: 'Free parking behind the building off Mary St. We use Davines products. Color appointments need a patch test 48h before if you are new to us. Kids cuts (under 12) are welcome as a regular Haircut.',
        // Memberships and packs (core/memberships), also in the price list document.
        memberships: [
          { planId: 'plan-monthly', name: 'Willow Monthly', kind: 'monthly', price: 35, covers: [{ serviceId: 'svc-haircut', uses: 1 }], discountPercent: 10, discountServiceIds: ['svc-color'], active: true },
          { planId: 'plan-pack5', name: '5-Cut Pack', kind: 'pack', price: 180, covers: [{ serviceId: 'svc-haircut', uses: 5 }], discountPercent: 0, discountServiceIds: [], validDays: 180, active: true }
        ]
      }
    })
  },
  {
    slug: 'bluebonnet',
    build: () => base('bluebonnet', {
      name: 'Bluebonnet Hair Studio',
      type: 'salon',
      category: 'salon',
      location: { lat: 30.3108, lng: -97.7255, address: '4500 Duval St, Austin, TX 78751', neighborhood: 'Hyde Park' },
      config: {
        services: [
          svc('svc-womens-cut', "Women's Cut & Style", 60, 55, 'full_prepaid'),
          svc('svc-mens-cut', "Men's Cut", 30, 35, 'full_prepaid'),
          svc('svc-blowout', 'Blowout', 45, 45, 'full_prepaid'),
          svc('svc-balayage', 'Balayage', 180, 180, 'deposit_percent', { depositPercent: 30 })
        ],
        staff: [
          { staffId: 'staff-maya', name: 'Maya', services: ['svc-womens-cut', 'svc-blowout', 'svc-balayage'] },
          { staffId: 'staff-jordan', name: 'Jordan', services: ['svc-womens-cut', 'svc-mens-cut', 'svc-blowout'] }
        ],
        availability: { open: '10:00', close: '19:00', workingDays: ['tue', 'wed', 'thu', 'fri', 'sat'], minNoticeHours: 2, advanceDays: 30 },
        policies: {
          cancellation: 'Full refund if you cancel at least 24 hours before; no refund after that.',
          refundTiers: [{ hoursBefore: 24, refundPct: 100 }, { hoursBefore: 0, refundPct: 0 }]
        },
        faq: 'Street parking on Duval and 45th. Closed Sundays and Mondays. Balayage includes a toner and blowout. Bring inspiration photos — we love them.'
      }
    })
  },
  {
    slug: 'eastside',
    build: () => base('eastside', {
      name: 'Eastside Barber Co.',
      type: 'barber',
      category: 'barber',
      location: { lat: 30.2652, lng: -97.7305, address: '1100 E 6th St, Austin, TX 78702', neighborhood: 'East Austin' },
      config: {
        services: [
          svc('svc-cut', 'Haircut', 30, 30, 'full_prepaid'),
          svc('svc-beard', 'Beard Trim', 30, 18, 'full_prepaid'),
          svc('svc-cut-beard', 'Haircut + Beard', 60, 42, 'full_prepaid'),
          svc('svc-shave', 'Hot Towel Shave', 30, 35, 'full_prepaid')
        ],
        staff: [
          { staffId: 'staff-marcus', name: 'Marcus', services: ['svc-cut', 'svc-beard', 'svc-cut-beard', 'svc-shave'] },
          { staffId: 'staff-leo', name: 'Leo', services: ['svc-cut', 'svc-beard', 'svc-cut-beard'] }
        ],
        availability: { open: '09:00', close: '20:00', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], minNoticeHours: 1, advanceDays: 21 },
        policies: {
          cancellation: 'Full refund if you cancel 12 hours ahead; no refund for later cancellations or no-shows.',
          refundTiers: [{ hoursBefore: 12, refundPct: 100 }, { hoursBefore: 0, refundPct: 0 }]
        },
        faq: 'Walk-ins welcome when a chair is free, but bookings get priority. Paid parking on 6th St; free after 7pm on side streets. Complimentary Topo Chico with every cut.',
        memberships: [
          { planId: 'plan-cutclub', name: 'Eastside Cut Club', kind: 'monthly', price: 28, covers: [{ serviceId: 'svc-cut', uses: 1 }], discountPercent: 15, discountServiceIds: ['svc-beard', 'svc-shave'], active: true }
        ]
      }
    })
  },
  {
    slug: 'bartonsprings',
    build: () => base('bartonsprings', {
      name: 'Barton Springs Day Spa',
      type: 'spa',
      category: 'spa',
      location: { lat: 30.2627, lng: -97.7676, address: '2100 Barton Springs Rd, Austin, TX 78704', neighborhood: 'Zilker' },
      config: {
        services: [
          svc('svc-swedish', 'Swedish Massage (60 min)', 60, 95, 'deposit_fixed', { depositAmount: 30 }),
          svc('svc-deep', 'Deep Tissue Massage (90 min)', 90, 135, 'deposit_percent', { depositPercent: 30 }),
          svc('svc-facial', 'Signature Facial', 60, 85, 'full_prepaid')
        ],
        staff: [
          { staffId: 'staff-priya', name: 'Priya', services: ['svc-swedish', 'svc-deep'] },
          { staffId: 'staff-elena', name: 'Elena', services: ['svc-swedish', 'svc-facial'] }
        ],
        availability: { open: '10:00', close: '20:00', workingDays: EVERY_DAY, minNoticeHours: 3, advanceDays: 30 },
        policies: {
          cancellation: 'Full refund 48 hours ahead, half back from 24 hours, nothing inside 24 hours.',
          refundTiers: [{ hoursBefore: 48, refundPct: 100 }, { hoursBefore: 24, refundPct: 50 }, { hoursBefore: 0, refundPct: 0 }]
        },
        faq: 'Please arrive 15 minutes early to change. Free parking in our lot. Tell us about injuries or pregnancy when booking — we will match you with the right therapist.',
        memberships: [
          { planId: 'plan-massage3', name: 'Massage 3-Pack', kind: 'pack', price: 255, covers: [{ serviceId: 'svc-swedish', uses: 3 }], discountPercent: 0, discountServiceIds: [], validDays: 120, active: true }
        ]
      }
    })
  }
]

// John Doe: the customer the judge plays.
const PERSONA = {
  name: 'John Doe',
  home: { lat: 30.2459, lng: -97.7414, label: 'Home · Travis Heights', neighborhood: 'Travis Heights' },
  // Past visits seeded into the session's Willow copy so "my usual" is real.
  history: [
    { slug: 'willow', serviceId: 'svc-haircut', staffId: 'staff-ana', weeksAgo: 5, hour: 15 },
    { slug: 'willow', serviceId: 'svc-haircut', staffId: 'staff-ana', weeksAgo: 11, hour: 11 },
    { slug: 'willow', serviceId: 'svc-color', staffId: 'staff-ana', weeksAgo: 18, hour: 13 }
  ]
}

// Back-compat for the sandbox scripts: the Willow template.
function demoBusiness(overrides = {}) {
  return { ...CATALOG[0].build(), businessId: BUSINESS_ID, ...overrides }
}

module.exports = { BUSINESS_ID, TIMEZONE, CITY, CATALOG, PERSONA, demoBusiness, demoPaypal, demoPaypalAvailable }
