// @ts-check
'use strict'

// ─── Session MCP servers: connect your own AI agent ───────────────────────────
// Every demo session gets two MCP links (token in the URL, expiring with the
// session, seeing only that session's data):
//   • customer — John's side: find businesses, check times, book (paid from the PayPal linked once),
//     my bookings, cancel/reschedule. Same tools + business rules as the chat.
//   • business — the owner of Willow & Co.: schedule, revenue, customers, block
//     time, move/cancel bookings, refund, change services, staff, hours and
//     refund rules — money actions quote first and only run with confirm=true.
//     In a guided session whose salon isn't set up yet, it also sets the salon
//     up: a ready-made prompt + the documents give the owner's AI everything,
//     and the instructions make it guide the owner.
// Resources give the agent a full read of the session's context.

const { toolResult, RpcError, ERR } = require('./protocol')
const { getTools, executeTool } = require('../services/tools')
const concierge = require('../core/concierge')
const owner = require('../core/ownerOps')
const refundRequests = require('../core/refundRequests')
const ownerPaypal = require('../core/ownerPaypal')
const ownerSetup = require('../core/ownerSetup')
const manage = require('../core/ownerManage')
const memberships = require('../core/memberships')
const demoSetup = require('../core/demoSetup')
const { DESCRIPTION, DOCS } = require('../demo/setupDocs')
const trace = require('../services/trace')
const { formatMoney } = require('../utils/money')

const VERSION = '1.0.0'

// Booking tool definitions → MCP inputSchema.
function toSchema(t) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.parameters || {}).map(([k, v]) => [k, { type: v.type, description: v.description }])),
      required: t.required || []
    }
  }
}

const json = (uri, value) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] })

// ── Customer ─────────────────────────────────────────────────────────────────

function customerServer({ session, ctx, clientLabel }) {
  const hidden = new Set(['get_queue_token'])
  const tools = getTools(ctx).filter(t => !hidden.has(t.name))
  const first = (ctx.customer.name || 'the customer').split(' ')[0]
  return {
    info: { name: 'flow-customer', title: `Flow — ${ctx.customer.name}`, version: VERSION },
    instructions: [
      `You are booking on behalf of ${ctx.customer.name} in Austin, TX (a Flow demo session, PayPal sandbox — fake money).`,
      `Read flow://customer/profile first: it has ${first}'s location and their usual place.`,
      // The tester's own AI may know where its user really is; the demo city is Austin.
      `${ctx.customer.name} is a test customer for this demo, and the home in the profile is theirs: use it for every search, distance and time. Don't use, mention or compare your own user's real location. If where they are comes up, say plainly that this is a test account for a demo customer in Austin, so the results are for Austin.`,
      `Ask before booking anything. Paid services are paid from the PayPal ${first} linked once in Flow (bookings, deposits, packs and memberships alike). If a payment tool returns needsConnect, PayPal isn't linked yet: nothing was booked or charged; give ${first} its connectUrl (also in their Flow inbox) to connect once, then try again. Don't offer a PayPal checkout link.`,
      `If ${first} saved PayPal on an earlier payment: payments within the AI spending allowance ${first} set in their Flow Profile go through at once (the result says paidUnder "allowance"). Above the allowance you can't confirm for ${first}: book_appointment and pay_balance return needsApproval with an approvalUrl. Nothing is charged until ${first} presses Approve in their own Flow: show them the link (it's also in their Flow inbox), then call check_approval with the approval_id when they say they're done. confirm=true from you doesn't skip this. my_saved_paypal shows, changes (PayPal link) or removes the saved PayPal, and shows the allowance (you can't change it). Without a linked PayPal, payments return needsConnect (see above).`,
      `To cancel, call cancel_booking without confirm, tell ${first} the refund it quotes, then confirm.`,
      `Businesses may offer memberships (charged monthly to the saved PayPal) and packs (one payment): list_memberships, join_membership (quote first; it pays from the saved PayPal on confirm, with ${first}'s approval above the allowance), my_memberships, cancel_membership. Bookings a membership covers cost nothing; book_appointment works that out.`,
      `Anything the salon should know (allergies, care needs, what a photo or document ${first} shared with you shows) goes on the booking: notes in book_appointment, or add_booking_note for a booking that already exists. The owner sees it in their calendar.`,
      `Every PayPal payment comes with a paid PayPal invoice: get_my_invoices lists them with their PayPal links; send_my_invoice puts the receipt PDF in ${first}'s Flow inbox.`,
      `${first} can also move a booking (reschedule_booking, to another time and/or person), pay what's left on a deposit (pay_balance), or ask for money back without cancelling (request_refund: the business decides).`,
      `Stay with what ${first} asked for: never switch to another business or a similar-sounding name on your own (e.g. "Marco" is not "Marcus"); if a name isn't at that business, say so and ask.`
    ].join(' '),
    onInitialize: async (c, caps, version) => {
      await clientConnected(session, c, caps, version, clientLabel)
      return rememberClient(session, c, caps)
    },
    async listTools() { return tools.map(toSchema) },
    async callTool(name, args, conn) {
      if (!tools.some(t => t.name === name)) throw new RpcError(ERR.INVALID_PARAMS, `Unknown tool: ${name}`)
      await mcpEvent(session, `MCP → ${name} (customer)`, { args: Object.keys(args || {}) })
      const r = await executeTool(name, args || {}, ctx)
      // A payment waiting for the customer's click: an app that can open pages
      // for us gets the standard URL elicitation; any other app shows the link.
      if (r?.needsApproval && await opensPages(session, conn?.sessionId)) {
        await mcpEvent(session, 'Asked the AI app to open the approval page (URL elicitation)', { approval: r.approvalId })
        throw new RpcError(ERR.URL_ELICITATION_REQUIRED, 'This payment needs your approval in Flow.', {
          elicitations: [{ mode: 'url', elicitationId: r.approvalId, url: r.approvalUrl, message: `Approve ${formatMoney(r.amount, r.currency)} with your saved PayPal in Flow. Nothing is charged until you approve.` }]
        })
      }
      return toolResult(r, !!(r && r.error))
    },
    async listResources() {
      return [
        { uri: 'flow://customer/profile', name: `${ctx.customer.name} — profile`, description: 'Name, location, and usual places', mimeType: 'application/json' },
        { uri: 'flow://customer/bookings', name: 'Upcoming bookings', description: 'Bookings across every business', mimeType: 'application/json' },
        { uri: 'flow://city/businesses', name: 'Businesses in Austin', description: 'Every bookable business: services, prices, hours, staff, policies, FAQ, distance', mimeType: 'application/json' }
      ]
    },
    async readResource(uri) {
      const history = await concierge.visitHistory(ctx.catalog, ctx.customer.customerId)
      if (uri === 'flow://customer/profile') {
        const usual = ctx.catalog.filter(b => history[b.businessId]).map(b => ({ business: b.name, ...history[b.businessId] }))
        return json(uri, {
          name: ctx.customer.name, test_account: true,
          note: `A test customer for the Flow demo (PayPal sandbox, fake money). This location is their home for every search; your own user's real location doesn't apply.`,
          location: ctx.customerLocation, usual_places: usual
        })
      }
      if (uri === 'flow://customer/bookings') return json(uri, await executeTool('get_my_bookings', {}, ctx))
      if (uri === 'flow://city/businesses') return json(uri, ctx.catalog.map(b => concierge.businessInfo(b, ctx.customerLocation, history[b.businessId])))
      throw new RpcError(ERR.INVALID_PARAMS, `Unknown resource: ${uri}`)
    }
  }
}

// ── Business ─────────────────────────────────────────────────────────────────

const BUSINESS_TOOLS = [
  { name: 'get_schedule', description: 'Bookings and blocked time between two dates (default: today + 7 days). Each booking has a booking_id for other tools.',
    properties: { from_date: { type: 'string', description: 'YYYY-MM-DD (business local)' }, to_date: { type: 'string', description: 'YYYY-MM-DD (business local)' } }, required: [], run: owner.getSchedule },
  { name: 'get_revenue', description: 'Money collected through PayPal, refunds and net, by service.',
    properties: { days: { type: 'number', description: 'Look-back window in days (1–90, default 7)' } }, required: [], run: owner.getRevenue },
  { name: 'list_customers', description: 'Customers with visit counts, last booking and total spent.',
    properties: {}, required: [], run: owner.listCustomers },
  { name: 'block_time', description: 'Block time off so it can\'t be booked (all staff, or one person).',
    properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, start_time: { type: 'string', description: 'HH:mm local' }, end_time: { type: 'string', description: 'HH:mm local' }, staff_name: { type: 'string', description: 'Optional staff member' }, reason: { type: 'string', description: 'Shown on the calendar' } },
    required: ['date', 'start_time', 'end_time'], run: owner.blockTime },
  { name: 'reschedule_booking', description: 'Move a booking to a new time and/or another staff member (keeps the payment; tells the customer in their inbox).',
    properties: { booking_id: { type: 'string', description: 'From get_schedule' }, new_time: { type: 'string', description: 'YYYY-MM-DDTHH:mm local (optional if only the staff member changes)' }, staff_name: { type: 'string', description: 'Optional: move it to this staff member' } },
    required: ['booking_id'], run: manage.moveBooking },
  { name: 'add_booking', description: 'Add a booking taken in person or by phone (walk-in). The slot is then never offered to anyone else.',
    properties: { service_name: { type: 'string' }, start_time: { type: 'string', description: 'YYYY-MM-DDTHH:mm local' }, staff_name: { type: 'string', description: 'Optional' }, customer_name: { type: 'string' }, customer_phone: { type: 'string' }, paid: { type: 'boolean', description: 'true if they already paid in person' } },
    required: ['service_name', 'start_time'], run: manage.addBooking },
  { name: 'update_booking_status', description: "Mark whether the customer came: completed (came), no_show (didn't come), or confirmed (not marked yet, to undo).",
    properties: { booking_id: { type: 'string' }, status: { type: 'string', description: 'completed (came) | no_show | confirmed (not marked)' } },
    required: ['booking_id', 'status'], run: manage.updateBookingStatus },
  { name: 'request_balance', description: 'Send the customer a PayPal link (to their Flow inbox) for the rest of a deposit booking. Quote first, then confirm=true.',
    properties: { booking_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['booking_id'], run: manage.requestBalance },
  { name: 'refund_booking', description: 'Refund part or all of a payment via PayPal. Call WITHOUT confirm first to get the quote; tell the owner; only then call with confirm=true.',
    properties: { booking_id: { type: 'string', description: 'From get_schedule' }, amount: { type: 'number', description: 'Optional — defaults to everything still refundable' }, reason: { type: 'string', description: 'Shown to the customer' }, confirm: { type: 'boolean', description: 'true only after the owner agreed to the quoted refund' } },
    required: ['booking_id'], run: owner.refundBooking },
  { name: 'list_refund_requests', description: 'Refunds customers have asked for without cancelling: who, which booking, how much, and their reason. Answer each with refund_booking (any amount) or decline_refund_request.',
    properties: {}, required: [], run: b => refundRequests.listOpen(b) },
  { name: 'decline_refund_request', description: "Say no to a customer's refund request. They are told in their inbox, with the reason if you give one. No money moves.",
    properties: { booking_id: { type: 'string', description: 'From list_refund_requests' }, reason: { type: 'string', description: 'Shown to the customer (optional)' } },
    required: ['booking_id'], run: (b, args) => refundRequests.decline(b, args) },
  // PayPal disputes (core/disputes): drafted from the booking's own record, sent only on the owner's OK.
  { name: 'list_disputes', description: "PayPal disputes customers opened on payments: amount, reason, respond-by date, status, and the booking. Practice cases are marked practice (only in Flow).",
    properties: {}, required: [], run: async b => ({ disputes: await require('../core/disputes').list(b) }) },
  { name: 'draft_dispute_response', description: "Draft the business's response to a dispute from the booking's own record (when and how it was booked, payment, policy, whether the visit happened). Nothing is sent. Show the owner the draft and the facts it used.",
    properties: { dispute_id: { type: 'string', description: 'From list_disputes' } }, required: ['dispute_id'], run: (b, args) => require('../core/disputes').draft(b, args.dispute_id) },
  { name: 'send_dispute_response', description: 'Send the response (with the booking record as a PDF) to PayPal. Call WITHOUT confirm first; only after the owner agreed, call with confirm=true.',
    properties: { dispute_id: { type: 'string' }, note: { type: 'string', description: 'Optional: the response as the owner wants it (defaults to the draft)' }, confirm: { type: 'boolean', description: 'true only after the owner agreed' } },
    required: ['dispute_id'], run: (b, args) => require('../core/disputes').send(b, args.dispute_id, { note: args.note, confirm: !!args.confirm }) },
  { name: 'open_practice_dispute', description: "Open a practice dispute on a paid booking, to try the dispute flow (PayPal's sandbox can't open one by API). It stays in Flow, is labelled practice, and is never sent to PayPal.",
    properties: { booking_id: { type: 'string', description: 'A paid booking, from get_schedule' } }, required: ['booking_id'], run: (b, args) => require('../core/disputes').practice(b, args.booking_id) },
  { name: 'decide_dispute_for_testing', description: "PayPal sandbox only: decide a dispute (for the business or for the customer) to see how it ends. A practice case is decided in Flow.",
    properties: { dispute_id: { type: 'string' }, outcome: { type: 'string', description: 'business | customer' } }, required: ['dispute_id', 'outcome'],
    run: (b, args) => require('../core/disputes').sandbox(b, args.dispute_id, args.outcome === 'business' ? 'seller_wins' : args.outcome === 'customer' ? 'buyer_wins' : String(args.outcome)) },
  { name: 'accept_dispute', description: 'Accept the claim: PayPal returns the disputed amount to the customer. Call WITHOUT confirm first; only after the owner agreed, call with confirm=true.',
    properties: { dispute_id: { type: 'string' }, note: { type: 'string', description: 'Optional note to PayPal' }, confirm: { type: 'boolean' } },
    required: ['dispute_id'], run: (b, args) => require('../core/disputes').accept(b, args.dispute_id, { note: args.note, confirm: !!args.confirm }) },
  { name: 'cancel_booking', description: 'Cancel a booking for the customer and refund per policy, in full, or not at all. Quote first (no confirm), then confirm=true.',
    properties: { booking_id: { type: 'string', description: 'From get_schedule' }, refund: { type: 'string', description: 'policy (default), full or none' }, reason: { type: 'string', description: 'Shown to the customer' }, confirm: { type: 'boolean', description: 'true only after the owner agreed' } },
    required: ['booking_id'], run: owner.cancelBooking },
  // PayPal, run by Flow's backend on the connected account: no PayPal token needed.
  { name: 'paypal_account', description: "Is PayPal connected, where the money lands, and whether Flow can refund on the business's behalf.",
    properties: {}, required: [], run: ownerPaypal.paypalAccount },
  { name: 'paypal_payments', description: "Recent PayPal payments checked live with PayPal: status, PayPal fee, net to the business, refunds, and whether Flow's records match.",
    properties: { days: { type: 'number', description: 'Look-back window in days (1–90, default 30)' } }, required: [], run: ownerPaypal.paypalPayments },
  { name: 'paypal_payment', description: "One booking's full PayPal record: order and capture ids, status, fee, net, payer, and every refund.",
    properties: { booking_id: { type: 'string', description: 'From get_schedule or paypal_payments' } }, required: ['booking_id'], run: ownerPaypal.paypalPayment },
  // PayPal invoices: every PayPal-paid booking gets a paid invoice in the business's PayPal.
  { name: 'list_invoices', description: 'PayPal invoices for paid bookings (and packs): invoice number, customer, service, amount, status (paid, partly paid, refunded) checked live with PayPal, and any that are missing.',
    properties: { days: { type: 'number', description: 'Look-back window in days (1–90, default 30)' }, status: { type: 'string', description: 'Optional filter: paid, partly paid, refunded, not issued, problem' } }, required: [], run: ownerPaypal.listInvoices },
  { name: 'get_invoice', description: "One invoice in full by booking_id or invoice number: lines, what's paid, refunded and due, PayPal's live status, and the links (the owner's PayPal view and the customer's).",
    properties: { booking_id: { type: 'string' }, invoice_number: { type: 'string' } }, required: [], run: ownerPaypal.getInvoice },
  { name: 'send_invoice', description: "Send a booking's receipt PDF and PayPal invoice link to the customer's Flow inbox again. Quote first (no confirm), then confirm=true.",
    properties: { booking_id: { type: 'string' }, invoice_number: { type: 'string' }, confirm: { type: 'boolean' } }, required: [], run: ownerPaypal.sendInvoice },
  { name: 'issue_invoice', description: 'Create the PayPal invoice for a paid booking that has none (for example PayPal was down, or invoicing was just allowed), marked paid. Quote first, then confirm=true.',
    properties: { booking_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['booking_id'], run: ownerPaypal.issueInvoice },

  // Change the setup by asking (core/ownerSetup). Money changes quote first.
  { name: 'update_service', description: 'Change a service: price, length, name, or how it is paid (full, or a deposit; the rest is paid later with PayPal). "none" only for a free service. Price and payment changes return a quote first: tell the owner, then call again with confirm=true.',
    properties: { service_name: { type: 'string', description: 'Current name' }, new_name: { type: 'string' }, price: { type: 'number', description: 'USD' }, minutes: { type: 'number' }, payment: { type: 'string', description: 'full | deposit (none only if free)' }, deposit_percent: { type: 'number' }, deposit_amount: { type: 'number', description: 'USD' }, confirm: { type: 'boolean', description: 'true only after the owner agreed' } },
    required: ['service_name'], run: ownerSetup.updateService },
  { name: 'add_service', description: 'Add a new service (quote first, then confirm=true). Staff who do it can be named; default is everyone.',
    properties: { name: { type: 'string' }, minutes: { type: 'number' }, price: { type: 'number', description: 'USD' }, payment: { type: 'string', description: 'full (default) | deposit (none only if free)' }, deposit_percent: { type: 'number' }, deposit_amount: { type: 'number' }, staff_names: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' } },
    required: ['name', 'minutes', 'price'], run: ownerSetup.addService },
  { name: 'remove_service', description: 'Stop offering a service (quote first, then confirm=true). Bookings already made stay.',
    properties: { service_name: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['service_name'], run: ownerSetup.removeService },
  { name: 'update_staff', description: 'Change which services a staff member does (set the full list, or add/remove some), rename them, or add a new staff member (a new name creates them).',
    properties: { staff_name: { type: 'string' }, services: { type: 'array', items: { type: 'string' }, description: 'The full list of services they do' }, add_services: { type: 'array', items: { type: 'string' } }, remove_services: { type: 'array', items: { type: 'string' } }, new_name: { type: 'string' } },
    required: ['staff_name'], run: ownerSetup.updateStaff },
  { name: 'set_hours', description: 'Opening hours: one opening and closing time for all working days, and which days are open.',
    properties: { open: { type: 'string', description: 'HH:MM' }, close: { type: 'string', description: 'HH:MM' }, days: { type: 'array', items: { type: 'string' }, description: 'mon … sun' } },
    required: [], run: ownerSetup.setHours },
  { name: 'set_refund_policy', description: 'Refund rules for cancellations, widest window first, e.g. [{hours_before: 48, refund_percent: 100}, {hours_before: 24, refund_percent: 50}]. Quote first, then confirm=true. Later cancellations get nothing unless a 0-hour rule says otherwise.',
    properties: { rules: { type: 'array', items: { type: 'object', properties: { hours_before: { type: 'number' }, refund_percent: { type: 'number' } } } }, text: { type: 'string', description: 'The policy in one or two sentences for customers (optional)' }, confirm: { type: 'boolean' } },
    required: ['rules'], run: ownerSetup.setRefundPolicy },
  { name: 'remove_staff', description: 'Remove a staff member (quote first, then confirm=true). Their upcoming bookings stay; move them first.',
    properties: { staff_name: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['staff_name'], run: manage.removeStaff },
  { name: 'update_business_info', description: 'Change the business name, address, phone, or the tone the booking assistant uses with customers.',
    properties: { name: { type: 'string' }, address: { type: 'string' }, phone: { type: 'string' }, assistant_tone: { type: 'string', description: 'e.g. "warm and concise"' } },
    required: [], run: manage.updateBusinessInfo },
  { name: 'list_knowledge', description: 'What the assistant knows from the business\'s documents (the knowledge base).',
    properties: {}, required: [], run: manage.listKnowledge },
  { name: 'add_knowledge', description: 'Teach the assistant something customers ask about (FAQ, parking, aftercare…). It is stored with Claude, which reads it whole when a customer asks.',
    properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['text'], run: manage.addKnowledge },
  { name: 'ask_knowledge', description: 'Check the knowledge base: the answer a customer asking this would get, read from the documents by Claude, with the quoted sources (document, and page for PDFs).',
    properties: { question: { type: 'string', description: 'What a customer might ask, e.g. "Is there parking?"' } }, required: ['question'], run: manage.askKnowledge },
  { name: 'remove_knowledge', description: 'Remove one document from the knowledge base by its name (from list_knowledge). Quote first, then confirm=true.',
    properties: { file: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['file'], run: manage.removeKnowledge },
  { name: 'clear_knowledge', description: 'Delete everything in the knowledge base (quote first, then confirm=true).',
    properties: { confirm: { type: 'boolean' } }, required: [], run: manage.clearKnowledge },
  // Memberships and packs (core/memberships): charged to the member's saved PayPal (monthly, or once).
  { name: 'list_memberships', description: 'Membership and pack plans, every member (uses left, renewal, failed payments), monthly recurring revenue and pack sales.',
    properties: {}, required: [], run: b => memberships.overview(b) },
  { name: 'create_membership_plan', description: 'Create a monthly membership (charged monthly to each member\'s saved PayPal) or a pack (one payment). covers = uses of services, e.g. [{service_name: "Haircut", uses: 1}]; optional member discount. Quote first, then confirm=true.',
    properties: { name: { type: 'string' }, kind: { type: 'string', description: 'monthly | pack' }, price: { type: 'number', description: 'USD (a month, or once for a pack)' }, covers: { type: 'array', items: { type: 'object', properties: { service_name: { type: 'string' }, uses: { type: 'number' } } } }, discount_percent: { type: 'number' }, discount_services: { type: 'array', items: { type: 'string' }, description: 'Services the discount applies to (default: other services)' }, valid_days: { type: 'number', description: 'Packs only (default 180)' }, confirm: { type: 'boolean' } },
    required: ['name', 'price'], run: memberships.createPlan },
  { name: 'update_membership_plan', description: 'Change a plan: name, price (current members keep theirs), what it covers, the discount, or pause it (active=false: no new members). Quote first, then confirm=true.',
    properties: { plan_name: { type: 'string' }, new_name: { type: 'string' }, price: { type: 'number' }, covers: { type: 'array', items: { type: 'object', properties: { service_name: { type: 'string' }, uses: { type: 'number' } } } }, discount_percent: { type: 'number' }, discount_services: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' }, confirm: { type: 'boolean' } },
    required: ['plan_name'], run: memberships.updatePlan },
  { name: 'cancel_member', description: "Cancel a member's monthly membership (PayPal stops billing; their uses last until the end of the month). Quote first, then confirm=true.",
    properties: { customer_name: { type: 'string' }, plan_name: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['customer_name'], run: memberships.cancelMember },
  { name: 'paypal_connect', description: 'Connect PayPal: returns the PayPal link the owner opens to sign in and connect. In the sandbox demo, use_demo_account=true connects the demo salon account instead.',
    properties: { use_demo_account: { type: 'boolean' } }, required: [], run: manage.paypalConnect }
]

const SETUP_STEPS = [
  'Read the description and the documents (the set_up_my_salon prompt has them all, or read the flow://setup/... resources).',
  'Draft from them only, never invent: services (name, minutes, USD price, how it is paid: full, deposit with percent or amount, or none), staff and which services each does, opening hours and days, refund rules (hours before → refund percent), the cancellation policy text, and any memberships (monthly) or packs (paid once) the price list offers.',
  'Call create_salon WITHOUT confirm and show the owner the draft as a short list.',
  'When the owner agrees, call create_salon with confirm=true.',
  'Call learn_documents so the FAQ and policy answer customer questions: it first shows what Claude will store; show the owner, then confirm.',
  'Ask what they would like to change, and use update_service, add_service, remove_service, update_staff, set_hours or set_refund_policy (price and refund changes are quoted first).',
  'If anything fails, offer use_ready_made_salon.'
]

// Guided demo: set the salon up from the owner's own AI.
function setupTools(session) {
  return [
    { name: 'create_salon', description: 'Set the salon up from what you read in its documents. First call WITHOUT confirm: Flow checks the data and returns the draft to show the owner. After the owner agrees, call with confirm=true. Only while the salon is not set up yet.',
      properties: {
        services: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, minutes: { type: 'number' }, price: { type: 'number', description: 'USD' }, payment: { type: 'string', description: 'full | deposit (none only if free)' }, deposit_percent: { type: 'number' }, deposit_amount: { type: 'number' } } } },
        staff: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, services: { type: 'array', items: { type: 'string' }, description: 'Service names they do' } } } },
        hours: { type: 'object', properties: { open: { type: 'string', description: 'HH:MM' }, close: { type: 'string', description: 'HH:MM' }, days: { type: 'array', items: { type: 'string' }, description: 'mon … sun' } } },
        refund_rules: { type: 'array', items: { type: 'object', properties: { hours_before: { type: 'number' }, refund_percent: { type: 'number' } } } },
        memberships: { type: 'array', description: 'Memberships (PayPal monthly) and packs (one payment) the documents offer', items: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', description: 'monthly | pack' }, price: { type: 'number' }, covers: { type: 'array', items: { type: 'object', properties: { service_name: { type: 'string' }, uses: { type: 'number' } } } }, discount_percent: { type: 'number' }, discount_services: { type: 'array', items: { type: 'string' } }, valid_days: { type: 'number' } } } },
        cancellation_text: { type: 'string' },
        reschedule_text: { type: 'string' },
        confirm: { type: 'boolean', description: 'true only after the owner approved the draft' }
      },
      required: [], run: (business, args) => demoSetup.createFromConfig(session, args) },
    { name: 'use_ready_made_salon', description: 'Fallback: set the salon up from the ready-made Willow & Co. template instead (only if the owner wants it or create_salon keeps failing).',
      properties: {}, required: [], run: async () => {
        if (session.setupDone !== false) return { error: 'The salon is already set up.' }
        const out = await demoSetup.apply(session, { source: 'template' })
        return { created: true, salon: out.config, next: 'Call learn_documents to add the FAQ and policy to the knowledge base.' }
      } },
    { name: 'learn_documents', description: "Add the salon's FAQ (a PDF) and booking policy to the knowledge base, stored with Claude, so customers' questions are answered from them. Without confirm it shows what Claude will store (format, size); show the owner, then call again with confirm=true to save.",
      properties: { document_ids: { type: 'array', items: { type: 'string' }, description: 'faq and/or policy (default both)' }, confirm: { type: 'boolean' } },
      required: [], run: async (business, args) => {
        const docIds = Array.isArray(args.document_ids) && args.document_ids.length ? args.document_ids : ['faq', 'policy']
        try {
          if (!args.confirm) {
            // Quote first, like every other change: what each document becomes, without the full text.
            const { documents } = await demoSetup.learnPreview(session, { docIds })
            return {
              needs_confirmation: true,
              will_store: documents.map(d => d.error ? { document: d.title, error: d.error } : { document: d.title, from: d.from, saved_as: d.storedAs === 'pdf' ? 'PDF (Claude reads the pages as pictures)' : 'text', reads_per_question: d.tokens ? `about ${d.tokens} tokens` : 'unknown', ...(d.pdfTokens ? { as_a_pdf_it_would_be: `about ${d.pdfTokens} tokens` } : {}), starts: String(d.text || '').slice(0, 160) }),
              next: 'Show the owner what will be stored, then call learn_documents again with confirm=true.'
            }
          }
          return await demoSetup.learn(session, { docIds })
        } catch (err) {
          if (err.code === 'NO_DOCS' || err.code === 'DEMO_LIMIT') return { error: err.message }
          throw err
        }
      } }
  ]
}

// A business the judge added on the map (core/addedBusiness): there are no
// documents, so the owner's own AI asks them, then sends it in Flow's format.
function addedSetupInstructions(business) {
  const kind = require('../core/addedBusiness').KINDS[business.category] || business.category
  return [
    `${business.name} is a ${String(kind).toLowerCase()} the owner just added to Flow's demo city (Austin, TX, near ${business.location?.neighborhood || 'the customer'}; PayPal sandbox, fake money). It is NOT set up yet. Help the owner set it up, one short question at a time:`,
    '1. Ask what they offer: each service with its price in USD and how long it takes, and whether customers pay in full when booking or pay a deposit (percent or amount); the rest is paid with PayPal before the visit. There is no paying at the visit, so the people who book show up.',
    '2. Ask who works there and which services each person does.',
    '3. Ask the opening hours and days, and the cancellation policy: how many hours before still gets a full or part refund.',
    '4. Optionally ask about memberships (monthly) or packs (paid once).',
    '5. Call create_business WITHOUT confirm, with exactly what they told you, and show them the draft as a short list. Never invent services, prices, staff or refund terms.',
    '6. When they agree, call create_business with confirm=true. Customers can book it straight away (web chat, voice assistant, their own AI).',
    '7. Then offer changes with update_service, add_service, update_staff, set_hours or set_refund_policy.'
  ]
}

// create_business: create_salon's format, for a business the judge added.
function addedSetupTools(session, business) {
  const salon = setupTools(session).find(t => t.name === 'create_salon')
  return [{
    name: 'create_business',
    description: `Set ${business.name} up from what the owner told you. First call WITHOUT confirm: Flow checks the data and returns the draft to show the owner. After the owner agrees, call with confirm=true.`,
    properties: salon.properties, required: [],
    run: (b, args) => require('../core/addedBusiness').createFromConfig(session, b, args)
  }]
}

function setupPromptText(business) {
  return [
    `Set up my salon, ${business.name}, on Flow. Here is everything you need.`,
    `\nDescription:\n${DESCRIPTION}`,
    ...DOCS.map(d => `\n--- ${d.title} (${d.kind === 'pdf' ? 'PDF' : 'text'}; ${d.use === 'knowledge' ? 'for the knowledge base' : d.use === 'both' ? 'for setup and the knowledge base' : 'for setup'}) ---\n${d.text}`),
    `\nSteps:\n${SETUP_STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    '\nKeep it short and friendly: I want to see the draft before you create anything.'
  ].join('\n')
}

// The session's name vault when this business hides customer names from the owner's AI, else null.
async function ownerVault(session, business) {
  const fresh = await require('../services/dynamo/businesses').getBusiness(business.businessId).catch(() => null)
  if (!(fresh || business)?.config?.ai_config?.hideCustomerNamesFromOwnerAi) return null
  return require('../services/pii').vaultFor(session)
}

// Every customer name in the result joins the vault, then the result goes out tokenized.
async function hideNames(vault, session, result) {
  const pii = require('../services/pii')
  for (const n of pii.namesIn(result)) vault.add(n)
  await pii.persist(vault, session.expiresAt).catch(() => {})
  return vault.tokenizeDeep(result)
}

function businessServer({ session, business, clientLabel }) {
  const unset = !(business.config?.services || []).some(s => s.active !== false)
  // A business the judge added (core/addedBusiness) is set up from the owner's own words, not Willow's documents.
  const added = !!business.addedByJudge
  // Setting up from scratch: the session's own salon, or a business the judge added.
  const tools = [...BUSINESS_TOOLS, ...(business.businessId === session.businessId ? setupTools(session) : added && business.setupDone === false ? addedSetupTools(session, business) : [])]
  const instructions = unset && added
    ? addedSetupInstructions(business)
    : unset
    ? [
      `${business.name} (a Flow demo salon in Austin, TX; PayPal sandbox, fake money) is NOT set up yet, and the owner wants your help to set it up. Guide them step by step, one step at a time:`,
      ...SETUP_STEPS.map((s, i) => `${i + 1}. ${s}`),
      'Never invent services, prices, staff or refund terms: use only what the documents say.'
    ]
    : [
      `You help the owner run ${business.name} (a Flow demo business in Austin, TX; PayPal sandbox — fake money).`,
      'Read flow://business/profile for services, staff, hours and policies.',
      'refund_booking and cancel_booking move money: always call without confirm first, tell the owner the exact amount, and only confirm after they agree.',
      'Customers can ask for money back without cancelling: list_refund_requests shows them; answer with refund_booking (any amount) or decline_refund_request.',
      'PayPal disputes: list_disputes shows them; draft_dispute_response writes a response from the booking record (show the owner the draft and the facts); send_dispute_response and accept_dispute go to PayPal only after a call without confirm and the owner’s yes. Never invent facts for a dispute.',
      'To change the setup use update_service, add_service, remove_service, update_staff, set_hours and set_refund_policy; price, payment and refund changes return a quote first and need confirm=true after the owner agrees.',
      'Memberships and packs (charged to the member\'s saved PayPal, monthly or once): list_memberships, create_membership_plan, update_membership_plan, cancel_member.',
      "PayPal is handled by Flow's backend on the account the business connected: use paypal_account, paypal_payments and paypal_payment for live PayPal data (fees, net, refunds). No PayPal token is needed.",
      'Every PayPal-paid booking gets a paid PayPal invoice in the business\'s PayPal account, and refunds are recorded on it: list_invoices, get_invoice, send_invoice (puts the receipt PDF + invoice link in the customer\'s inbox), issue_invoice (for a missing one).',
      'Times are business-local (America/Chicago).'
    ]
  return {
    info: { name: 'flow-business', title: `Flow — ${business.name} (owner)`, version: VERSION },
    instructions: instructions.join(unset ? '\n' : ' '),
    onInitialize: (c, caps, version) => clientConnected(session, c, caps, version, clientLabel),
    async listTools() {
      return tools.map(t => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required } }))
    },
    async listPrompts() {
      if (added) return business.setupDone === false ? [{ name: 'set_up_my_business', title: 'Set up my business', description: `Set ${business.name} up on Flow: I'll ask you about it, then show you the draft before anything is created.` }] : []
      return [{ name: 'set_up_my_salon', title: 'Set up my salon', description: `Set ${business.name} up from its description and documents, step by step, with you approving the draft.` }]
    },
    async getPrompt(name) {
      if (added && name === 'set_up_my_business' && business.setupDone === false) {
        await mcpEvent(session, `MCP prompt: Set up my business (${business.name})`)
        return { description: `Set ${business.name} up on Flow`, messages: [{ role: 'user', content: { type: 'text', text: addedSetupInstructions(business).join('\n') } }] }
      }
      if (name !== 'set_up_my_salon') throw new RpcError(ERR.INVALID_PARAMS, `Unknown prompt: ${name}`)
      await mcpEvent(session, 'MCP prompt: Set up my salon (business)')
      return {
        description: `Set ${business.name} up on Flow`,
        messages: [{ role: 'user', content: { type: 'text', text: setupPromptText(business) } }]
      }
    },
    async callTool(name, args) {
      const t = tools.find(x => x.name === name)
      if (!t) throw new RpcError(ERR.INVALID_PARAMS, `Unknown tool: ${name}`)
      await mcpEvent(session, `MCP → ${name} (business)`, { args: Object.keys(args || {}) })
      // The owner can hide customer names from their own AI (Settings; PRIVACY_TOKENS.md):
      // then names go out as tokens, and tokens coming back are decoded here.
      const vault = await ownerVault(session, business)
      if (vault?.unknownTokens(args || {}).length) return toolResult({ error: "That name token isn't one Flow gave you. Use the tokens exactly as they appear." }, true)
      const real = vault ? vault.detokenizeDeep(args || {}) : (args || {})
      const r = await trace.run(`sess:${session.sid}`, () => trace.forBusiness(business, () => trace.span('tool', `Owner tool: ${name}`, () => t.run(business, real),
        x => ({ ok: !x?.error, ...(x?.needs_confirmation ? { quote: true } : {}) }))))
      const out = vault ? await hideNames(vault, session, r) : r
      return toolResult(out, !!(out && out.error))
    },
    async listResources() {
      return [
        { uri: 'flow://business/profile', name: `${business.name} — profile`, description: 'Services, prices, staff, hours, policies, FAQ', mimeType: 'application/json' },
        { uri: 'flow://business/schedule', name: 'Schedule (next 14 days)', description: 'Bookings and blocked time', mimeType: 'application/json' },
        { uri: 'flow://business/payments', name: 'Payments & refunds (last 30 days)', description: 'PayPal totals by service', mimeType: 'application/json' },
        { uri: 'flow://setup/status', name: 'Setup status', description: 'Is the salon set up, are the documents learned, and what to do next', mimeType: 'application/json' },
        { uri: 'flow://setup/description', name: 'The salon in the owner\'s words', description: 'Description to set the salon up from', mimeType: 'text/plain' },
        ...DOCS.map(d => ({ uri: `flow://setup/documents/${d.id}`, name: `${d.title} (${d.kind === 'pdf' ? 'PDF' : 'text'})`, description: d.summary, mimeType: 'text/plain' }))
      ]
    },
    async readResource(uri) {
      if (uri === 'flow://business/profile') {
        const c = business.config
        return json(uri, { name: business.name, address: business.location?.address, timezone: business.timezone, currency: c.currency, setup: ownerSetup.setupView(business), hours: c.availability, services: c.services, staff: (c.staff || []).map(s => ({ name: s.name, services: s.services })), policies: c.policies, faq: c.faq, paypal: business.paypalMerchantId ? 'connected (sandbox)' : 'platform sandbox account' })
      }
      if (uri === 'flow://setup/status') {
        const learned = session.knowledge?.docs || []
        return json(uri, {
          set_up: !unset,
          documents_learned: learned.map(d => d.title),
          next: unset ? 'Read the documents and call create_salon (without confirm first).' : !learned.length ? 'Call learn_documents.' : 'Offer the owner changes (update_service, add_service, update_staff, set_hours, set_refund_policy).',
          setup: unset ? null : ownerSetup.setupView(business)
        })
      }
      if (uri === 'flow://setup/description') return { contents: [{ uri, mimeType: 'text/plain', text: DESCRIPTION }] }
      const doc = DOCS.find(d => uri === `flow://setup/documents/${d.id}`)
      if (doc) return { contents: [{ uri, mimeType: 'text/plain', text: doc.text }] }
      if (uri === 'flow://business/schedule') {
        const today = require('../utils/time').dayjs().tz(business.timezone)
        return json(uri, await owner.getSchedule(business, { from_date: today.format('YYYY-MM-DD'), to_date: today.add(14, 'day').format('YYYY-MM-DD') }))
      }
      if (uri === 'flow://business/payments') return json(uri, await owner.getRevenue(business, { days: 30 }))
      throw new RpcError(ERR.INVALID_PARAMS, `Unknown resource: ${uri}`)
    }
  }
}

// Which ways the AI app can ask its user something for Flow (MCP elicitation):
// "form" is a dialog in the app, "url" opens a page. An empty object means form.
function elicitationModes(caps) {
  const e = caps && caps.elicitation
  if (!e || typeof e !== 'object') return []
  const modes = Object.keys(e).filter(k => k === 'form' || k === 'url')
  return modes.length ? modes : ['form']
}

function clientConnected(session, c, caps, version, clientLabel) {
  const modes = elicitationModes(caps)
  return mcpEvent(session, `MCP client connected: ${c.name || 'unknown'}${c.version ? ` ${c.version}` : ''} (${clientLabel} link)`, {
    protocol: version,
    asksYouDirectly: modes.length ? modes.map(m => (m === 'form' ? 'a dialog in the app' : 'a page it opens')).join(' and ') : 'no (the AI asks you instead)'
  })
}

// Only an app that can open pages for us (URL elicitation) gets an Mcp-Session-Id;
// its modes are kept so later tool calls know they can use it.
async function rememberClient(session, c, caps) {
  const modes = elicitationModes(caps)
  if (!modes.includes('url')) return null
  const sessionId = require('crypto').randomBytes(16).toString('hex')
  await require('../services/demoStore').store().putKey(`MCPCLIENT#${session.sid}`, sessionId, { modes, name: c.name || null }, session.expiresAt)
  return { sessionId }
}

async function opensPages(session, sessionId) {
  if (!sessionId || !/^[0-9a-f]{32}$/.test(sessionId)) return false
  const rec = await require('../services/demoStore').store().getKey(`MCPCLIENT#${session.sid}`, sessionId)
  return !!rec?.modes?.includes('url')
}

function mcpEvent(session, title, detail) {
  return trace.run(`sess:${session.sid}`, async () => trace.event('mcp', title, detail)).catch(() => {})
}

module.exports = { customerServer, businessServer, BUSINESS_TOOLS, elicitationModes }
