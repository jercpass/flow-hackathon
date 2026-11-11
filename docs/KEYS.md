# Keys: Claude, Gemini and PayPal sandbox

**The file you edit:** `apps/lambda/.env`. It's already created, with every line explained. Git ignores it, so your keys never get committed. `apps/lambda/.env.example` is the same file without values; it's the copy that's committed.

**When you're done, check everything:**
```bash
node apps/lambda/scripts/check-keys.js
```
It makes one tiny real call per service and prints ✓ or ✗ with the reason. It never prints a key. The AI checks cost a fraction of a cent.

Never paste a key into a chat or a commit. Use sandbox and test values only.

## What goes where

| `.env` line | What it does | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Haiku 5.5 does the thinking (chat, booking, photos, PDFs, setup) | console.anthropic.com → API Keys |
| `GOOGLE_API_KEY` | Gemini is the backup for voice notes and for Claude | aistudio.google.com → API keys |
| `GROQ_API_KEY` | Groq's Whisper turns voice notes into text (free plan). Empty = Gemini does it | console.groq.com → API Keys |
| (no key) | Amazon Polly speaks the voice page's replies, through your AWS login | – |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Flow's PayPal sandbox app: payments, refunds, invoices | developer.paypal.com → Apps & Credentials → **Sandbox** |
| `PAYPAL_PARTNER_MERCHANT_ID` | Flow's own sandbox Business account: it owns the app, and the demo salon is paid into it, so payments, refunds, invoices and memberships all show up there | developer.paypal.com → Testing Tools → Sandbox Accounts |
| `PAYPAL_PLATFORM_EMAIL` | That account's sandbox login: the invoicer on invoices, and the login that shows the payments in PayPal's sandbox | same place |
| `DEMO_BUYER_EMAIL`, `DEMO_BUYER_PASSWORD` | The test buyer that pays in the demo (shown on the demo page; fake money) | same place, a Personal account |
| `REDIS_URL` | Optional: a faster cache. Empty is fine: seat holds use DynamoDB | upstash.com, free |
| `AI_PROVIDER`, `AI_MODEL`, `AI_BACKUP_MODEL` | Leave empty. Claude is used automatically when its key is set | — |
| `PAYPAL_WEBHOOK_ID` | Only after deploying | `node apps/lambda/scripts/paypal-webhook.js --apply --save` registers it and saves the id |

**If you leave `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` or `REDIS_URL` empty,** the local server looks for a copy in AWS SSM (`/flow/…`), if you keep one there. **Keys already set in your terminal are ignored**, so a key that belongs to another tool can't be used by mistake.

## Step by step

### 1. Claude (Anthropic)
1. Sign in at **console.anthropic.com**. At the top, check you're in the account (organization) where you added credit.
2. **Plans & Billing:** confirm the credit shows there.
3. **API Keys → Create Key.** Copy it (it starts with `sk-ant-`); it's shown only once.
4. Paste it after `ANTHROPIC_API_KEY=` in `apps/lambda/.env`.


#### Set the Console up for low, capped usage (platform.claude.com)
The model and token settings live in Flow's code (below), not on Console pages. The Console only needs credit, a key and a cap:
1. **Plans & Billing:** add a little credit (for example $10–20). Keep auto-reload off, so the bill can't run on.
2. **Settings → Workspaces:** create a workspace called **Flow**. In its limits, set a **monthly spend limit** (for example $20). Requests stop at the cap instead of costing more.
3. **API keys:** create the key **inside the Flow workspace**, so it counts against that cap. Put it in `apps/lambda/.env` (and, for the deployed version, in SSM, below).
4. **Messages, Agents, Resources:** nothing to set.
   - Flow calls the Messages API with its own tools and its own MCP servers.
   - "Agents" (Managed Agents) would replace Flow's loop and hosting, which it doesn't need.
   - The Messages workbench is only for trying prompts.
5. **Usage:** watch the tokens and the cache reads. Most input should show as cache reads once a conversation gets going.

#### What the code does to keep tokens low (`services/ai.js`)
- **Haiku 5.5** for chat, with **Sonnet 5.5** only as the backup.
- **Effort `low`** for chat: short replies and tool calls need little thinking. Set `AI_EFFORT=medium` or `high` to raise it.
- **Caching:**
  - The tools plus the system prompt (the city, services, rules) are cached.
  - The conversation is cached too, so each tool round reads the last one from cache.
  - The system prompt holds only the date. The exact time is a note on the new message, so the prompt doesn't change every minute and miss the cache.
- **Room, not cost:** `max_tokens` is 4096, because thinking counts toward it, and only what's generated is billed. A reply cut off mid tool call is never run; a declined request goes to the backup model.
- **Under the hood** shows each turn's tokens, for example "in 10,720 (5,300 cached) · out 70".

### 2. Gemini (Google)
1. Sign in at **aistudio.google.com** → **API keys**. Use the key whose project has billing on, or create one there.
2. Paste it after `GOOGLE_API_KEY=`.
3. In **console.cloud.google.com → Billing → Budgets & alerts**, keep a small budget (for example $10).


### 2b. Groq (voice notes) and Amazon Polly (spoken replies)
1. Sign in at **console.groq.com** (free, no card) → **API Keys** → **Create API Key**. Paste it after `GROQ_API_KEY=`.
2. Polly needs no key: it uses the AWS login the local server already uses. Deployed, the Lambda role has `polly:SynthesizeSpeech`.
3. Run the check below: **Voice** shows ✓ for both.

### 3. PayPal sandbox
1. Sign in at **developer.paypal.com** with your PayPal account.
2. **Apps & Credentials → Sandbox** (not Live) → **Create App** (merchant type). Copy the **Client ID** and **Secret** into `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`.
3. **Testing Tools → Sandbox Accounts.** You need two accounts. Create any that are missing yourself; each shows an **Account ID** (13 letters/digits) and a sandbox login.
   - **Business account (Flow):** Account ID → `PAYPAL_PARTNER_MERCHANT_ID`; its login → `PAYPAL_PLATFORM_EMAIL`. The app belongs to this account, and the demo salon is paid into it.
   - **Personal account (the buyer):** login and password → `DEMO_BUYER_EMAIL` / `DEMO_BUYER_PASSWORD`.
4. In the app's **Features**, tick **Invoicing** (and keep **Subscriptions** on), then **Save**. `check-keys.js` tells you if either is off.
5. Keep `PAYPAL_ENV=sandbox`.

> **Why one Business account:** PayPal only lets an app refund, invoice and run memberships on accounts it has partner access to, and a normal sandbox app has none. So the demo salon is paid into the account that owns the app. "Connect your own PayPal" needs PayPal partner access.

### 4. Optional: Redis
**upstash.com** → create a free Redis database → copy the `rediss://…` URL into `REDIS_URL`. Without it, Flow keeps seat holds in DynamoDB.

## Test it

1. Run the key check:
   ```bash
   node apps/lambda/scripts/check-keys.js
   ```
2. Restart the local API so it picks up the new keys (stop it and run `node apps/lambda/scripts/local-api.js`). Its first line shows which AI it uses, for example `AI: anthropic claude-haiku-5-5`.
3. **PayPal on its own:** create an order, approve it in the browser with the sandbox buyer, then capture and refund. Approving in PayPal is yours to do.
   ```bash
   node apps/lambda/scripts/paypal-sandbox-e2e.js
   ```
4. **The whole demo:** open http://localhost:3000, start the guided demo, book, pay with the sandbox buyer, then cancel. The **Under the hood** tab should show "Asked Claude Haiku 5.5", the PayPal order, capture, invoice and refund, and both inboxes should get messages.

## For the deployed version

The deployed backend doesn't read `.env`. It reads the same values from **AWS SSM under `/flowhq/…` in US East (`us-east-1`)**. Each `.env` line has a matching setting there, for example `ANTHROPIC_API_KEY` → `/flowhq/anthropic/apiKey`. Save each one with `aws ssm put-parameter --region us-east-1 --type SecureString --name /flowhq/anthropic/apiKey --value <your key>`, then deploy with `npm run deploy --workspace=apps/lambda`.

Locally, `.env` is all you need.
