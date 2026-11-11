# Privacy tokens: customer names never reach the AI

Flow's AI (Claude) books, pays and refunds for real customers, but it never learns who they are. Every customer name goes into the AI as a token like `⟦pii:K7QX2M9P⟧`, and code puts the real name back only for the person allowed to read or hear it.

## Try it in the demo

1. Start a session and log in with PayPal. Flow now knows your name.
2. Ask in the web chat: *"What's my name?"* or *"Book my usual haircut"*. The reply uses your real name.
3. Open **Under the hood**. The same turn shows only `⟦pii:…⟧` tokens: in what Claude was asked, in the tool calls and in the reply it wrote.

## Who sees what

| Where | Customer names |
|---|---|
| The person in the conversation: web chat, Flow Voice, Telegram, Alexa | Real, put back just before the reply is shown or spoken |
| Flow's AI (Claude) | Tokens only |
| Under the hood (the timeline) | Tokens only |
| The owner's dashboard: bookings, calendar, PayPal ledger, inbox | Real |
| The owner's own AI over MCP | Real, or tokens when the owner turns on **Hide customer names from my own AI** in Settings |
| A customer's own AI over MCP | Their own details only; other customers never appear |

## How it works

- **A vault per session.** It maps each token to a name. It's encrypted with AES-256-GCM, using a key derived (HKDF) from Flow's secret and the session id, and it's deleted with the session.
- **Stable tokens.** A token is an HMAC of the name with that key, so the same name gets the same token for the whole session, and one token never stands for two names.
- **Into Claude.** When a session has names in its vault, everything Claude reads is tokenized first: the system prompt, the conversation, the new message and every tool result. One line in the prompt tells Claude to treat a token as the name itself and speak naturally ("You're ⟦pii:K7QX2M9P⟧!"), never mentioning tokens.
- **Out of Claude.** Tool arguments are decoded inside Flow's code just before the tool runs. A token the vault doesn't know is refused, so the AI can't invent a customer. The reply is decoded before any channel shows or speaks it.
- **Under the hood.** Every timeline event is tokenized with the session's vault before it's written, so even a screenshot of the timeline shows no names.
- **Voice notes.** Whisper (on Groq) gets the customer's name as a spelling hint, so the transcript spells it exactly as the vault does and it can be tokenized.

## Where it is in the code

| File | What it does |
|---|---|
| [`apps/lambda/src/services/pii.js`](../apps/lambda/src/services/pii.js) | The vault: tokenize, decode, encrypted storage, the prompt line |
| [`apps/lambda/src/services/aiRouter.js`](../apps/lambda/src/services/aiRouter.js) | `privately()`: tokenizes what goes into Claude, decodes tool arguments and the reply |
| [`apps/lambda/src/services/trace.js`](../apps/lambda/src/services/trace.js) | Tokenizes timeline events before they're stored |
| [`apps/lambda/src/mcp/sessionServers.js`](../apps/lambda/src/mcp/sessionServers.js) | The owner's "hide names" switch for their own AI |
| [`apps/lambda/src/__tests__/pii.test.js`](../apps/lambda/src/__tests__/pii.test.js) | Tests: stable tokens, whole-word matching, unknown tokens refused, encrypted round trip |

## Limits

- **A name said for the first time,** like a friend the customer books for, is in that message, so Claude sees it once. Names Flow already knows are always tokenized.
- **Voice audio** goes to the speech-to-text service as audio. Only the text is tokenized.
- **PayPal** gets the payer's name, because it's the payment itself, not the AI.
- **Staff and business names** stay plain: they're public.
- **The booking database** keeps real names, so the owner's dashboard works as usual.
