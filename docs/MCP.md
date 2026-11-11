# Connect your own AI (MCP)

Customers and owners can run Flow from the AI app they already use: Claude, ChatGPT, Cursor or VS Code. Flow is an MCP server, so their AI gets Flow's real tools, not a copy of the website. It finds and books appointments, pays with PayPal and manages the business, under the same rules as Flow's own chat.

## Try it in the demo

1. Start a session, open **Your own AI** (customer side), and pick your app.
   - **Claude:** **Connect to Claude** opens Claude's "Add custom connector" box with Flow already filled in. Click **Add**.
   - **Cursor, VS Code:** one click installs it.
   - **ChatGPT:** the link is copied and ChatGPT's connector settings open (it needs Developer mode).
   - **Claude Code:** `claude mcp add --transport http flow <your link>`.
2. Ask your AI: *"Book my usual haircut for Saturday afternoon."*
3. Watch Flow's **Under the hood** timeline. Each step your AI takes shows up there, marked as MCP.

The owner side has its own link: **AI & channels → Connect your own AI**.

## Two servers, one engine

| | Customer link | Owner link |
|---|---|---|
| Who it's for | The customer's own AI | The business owner's own AI |
| Tools | 22: find businesses, check times, book, pay, move, cancel, request a refund, memberships, receipts | 43 that cover everything the dashboard does, plus setup tools while the salon isn't set up yet. They include the schedule, refunds by policy, invoices, disputes, memberships, the knowledge base and the salon setup |
| Context | Resources for the customer's profile, bookings and the city's businesses | Resources for the business profile, and a **Set up my salon** prompt with everything needed to set the salon up from scratch |

Both call the same tools as Flow's web chat, so there's one booking engine and one set of rules. The links are made for each demo session and stop working when it ends.

## When an AI wants to spend money

This is the agentic-commerce problem: what stops an AI from paying, or approving its own payment?

- **The AI's "yes" doesn't count.** Over MCP, an AI sending `confirm: true` isn't the customer agreeing.
- **The allowance decides.** In **Profile → AI spending allowance**, the customer sets a limit per booking and per month, and how long it lasts. Inside it, their AI can pay with their saved PayPal by itself. Code checks every payment against the allowance; the AI can't change it.
- **Above the allowance, nothing is charged.** Flow keeps a pending approval for 15 minutes and puts **Review and approve** in the customer's Flow inbox. The AI gets a link it can show, but not use.
- **If the app can open pages, Flow asks it to.** Apps that support MCP's URL elicitation open the approval page for their user automatically.
- **Retries are safe.** The same request from a retrying AI reuses the same approval, and the approve click is claimed once.
- **PayPal is told who started each charge.** An approved payment goes to PayPal with `stored_credential` initiator `CUSTOMER`. One inside the allowance goes as `MERCHANT`, with the allowance's mandate id on the order.

## Owners: setting up and running the business by asking

On the guided demo's setup page, **From your own AI** lets the owner set the salon up from their AI instead. Flow's server instructions tell the AI what's missing and the steps to take. The **Set up my salon** prompt carries the description and the documents. The AI drafts services, prices, staff, hours and refund rules, shows the draft, and creates the salon only when the owner agrees. The setup page fills in live as it happens.

After that, the owner can keep asking: *"Make Color & Gloss $130"*, *"Ben does colour too"*, *"Block 1 to 2 PM for lunch"*, *"How did this week go?"*. Anything that changes money is quoted first and applied only on confirm.

To keep names private from their own AI, the owner turns on **Settings → Hide customer names from my own AI**. Tool results then carry tokens instead of names ([Privacy tokens](PRIVACY_TOKENS.md)).

## Where it is in the code

| File | What it does |
|---|---|
| [`apps/lambda/src/mcp/protocol.js`](../apps/lambda/src/mcp/protocol.js) | MCP over Streamable HTTP: tools, resources, prompts, elicitation |
| [`apps/lambda/src/mcp/sessionServers.js`](../apps/lambda/src/mcp/sessionServers.js) | The customer and owner servers, their instructions, resources and the approval elicitation |
| [`apps/lambda/src/core/allowance.js`](../apps/lambda/src/core/allowance.js) | The AI spending allowance, checked in code |
| [`apps/lambda/src/core/approvals.js`](../apps/lambda/src/core/approvals.js) | Payments waiting for the customer's click |
| [`apps/dashboard/lib/McpConnect.js`](../apps/dashboard/lib/McpConnect.js) | The "Connect your own AI" card and each app's one-click setup |
