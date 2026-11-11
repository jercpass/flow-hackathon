# Channels: one engine, five ways to book

Customers book and pay wherever they already are: Flow's web chat, Flow Voice in the browser, Telegram, Alexa, or their own AI app. Every channel is a thin door into the same engine: the same AI, the same booking and payment tools, the same PayPal money path, the same Flow inbox and the same **Under the hood** timeline. No channel has business logic of its own, so a rule added once holds everywhere.

```text
web chat ─┐
Flow Voice┤
Telegram ─┼──▶  Flow's assistant (Claude)  ──▶  booking + payment tools  ──▶  PayPal
Alexa ────┤        prices, refunds and limits come from code, not the AI
your AI ──┘  (MCP: the customer's own AI calls the tools directly)
```

Flow answers in the customer's language: it replies in the language it's spoken to, and spoken replies use a matching voice.

## The channels

| Channel | What the customer does | How paying works |
|---|---|---|
| **Web chat** | Types, or sends a voice note (up to 1 minute), a photo of the cut they want, or a PDF, Word, Excel or text file (up to 4 MB). A voice note gets a spoken reply. | **Yes, pay with saved PayPal** in one tap, or the PayPal button |
| **Flow Voice** | Talks in the browser. The browser hears them, and Amazon Polly speaks Flow's replies. | Inside the AI allowance it pays by itself; otherwise the PayPal link goes to the Flow inbox |
| **Telegram** | Texts Flow's bot, or sends a voice note or a photo. Each store can also connect a bot of its own, which books that store only. | A one-tap saved-PayPal button, or **Pay with PayPal** |
| **Alexa** | *"Alexa, open Flow Bookings"*, then books by voice. The first time, they say the 4-digit code shown on their Flow page. | Inside the AI allowance it books and pays in one go; above it, an approval goes to the Flow inbox |
| **Your own AI (MCP)** | Asks Claude, ChatGPT, Cursor or VS Code, connected to Flow | Inside the allowance; above it, **Approve in Flow** ([Connect your own AI](MCP.md)) |

## Try it in the demo

Start a session at [flow-hackathon.onpratiks.com](https://flow-hackathon.onpratiks.com) and log in with PayPal. Then, on the customer side:
- **Web chat:** tap 🎙, say *"Book a beard trim tomorrow at five"*, then tap ■ to send. The answer comes back as a voice note.
- **Voice assistant:** talk to Flow Voice.
- **Telegram:** the Telegram page links the bot to your session with a button, or a QR code to scan with your phone.
- **Alexa:** use the developer console's test tab, or your own Echo through the beta test (add your Amazon email on the Alexa page).
- **Your own AI:** connect your AI app with one click.

Whichever channel you use, the booking lands on the owner's calendar, already paid, and every step appears on **Under the hood**.

## How the hard parts work

- **Telegram, a bot per store.** The owner pastes a bot token from BotFather. Flow checks it with Telegram, stores it on the server only, and points the bot's webhook at Flow with a secret header that's checked on every update. Bots answer private chats only, and repeated updates are dropped.
- **Alexa's 8-second clock.** A booking with a payment can take longer than Alexa waits. So the AI turn runs in a background run of the same function. If it's done within 6 seconds, Alexa answers at once; if not, Alexa says *"I'm on it… say go on"* and the next turn has the answer. One turn runs at a time per Alexa user, so nothing is booked twice.
- **Voice notes.** Groq's Whisper turns speech into text, with Gemini as the backup. The customer's name goes in as a spelling hint, so it's spelled the way Flow knows it.
- **Files.** Photos and PDFs go to Claude as they are. Word and Excel text is pulled out by Flow's own code, then Claude reads it like a PDF.
- **Names stay private.** On every channel, Claude sees customer names only as tokens ([Privacy tokens](PRIVACY_TOKENS.md)).

## Where it is in the code

| File | What it does |
|---|---|
| [`apps/lambda/src/core/concierge.js`](../apps/lambda/src/core/concierge.js) | The shared assistant every channel calls |
| [`apps/lambda/src/core/demoChat.js`](../apps/lambda/src/core/demoChat.js) | Web chat, including voice notes, photos and files |
| [`apps/lambda/src/core/voice.js`](../apps/lambda/src/core/voice.js) | Flow Voice, and Alexa's turns through it |
| [`apps/lambda/src/core/telegramBot.js`](../apps/lambda/src/core/telegramBot.js) | Telegram: Flow's bot and each store's bot |
| [`apps/lambda/src/core/alexa.js`](../apps/lambda/src/core/alexa.js) | Alexa: code linking and the background turn |
| [`apps/lambda/src/services/media.js`](../apps/lambda/src/services/media.js) | Voice-note and file limits |
| [`apps/lambda/src/services/speechToText.js`](../apps/lambda/src/services/speechToText.js), [`cloudTts.js`](../apps/lambda/src/services/cloudTts.js) | Hearing (Whisper) and speaking (Polly) |

The Alexa skill package and its setup are in [`docs/alexa`](alexa/README.md).
