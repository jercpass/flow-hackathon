# APIMatic: Flow's money path on PayPal's server SDK

Flow's payments run on **PayPal's official server SDK, [`@paypal/paypal-server-sdk`](https://www.npmjs.com/package/@paypal/paypal-server-sdk)**, which APIMatic generates from PayPal's API specs. It's pinned at `2.5.0` and built on APIMatic's runtime (`@apimatic/core`, `@apimatic/schema`, `@apimatic/axios-client-adapter`). I moved it in with the **APIMatic Context Plugin for PayPal** in Claude Code.

**No new keys.** The SDK uses the same PayPal sandbox app Flow already had (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`). Flow never calls APIMatic while it runs, and the Context Plugin needs no credentials.

## Before and after

The same refund, both ways:

```js
// Before: JSON and headers typed by hand
body.amount = { currency_code: currency, value: '24.00' }
call('post', `/v2/payments/captures/${captureId}/refund`, { requestId, body, headers: { 'PayPal-Auth-Assertion': assertion } })

// Now: PayPal's generated SDK
sdk.payments().refundCapturedPayment({
  captureId, body: { amount: { currencyCode: currency, value: '24.00' } },
  paypalRequestId: requestId, paypalAuthAssertion: assertion
})
```

| | Hand-written REST (before) | APIMatic SDK (now) |
|---|---|---|
| A missing or wrongly typed field | Checked by PayPal's API when the request arrives | Blocked before sending (`ArgumentsValidationError`; checked with a missing `amount` and with a number where PayPal wants a string) |
| URLs, header names | Typed by hand in Flow's code | Named operations and parameters from PayPal's spec |
| OAuth token | Flow's own cache | The SDK's token manager |
| A stuck call | No timeout | 15 s |
| PayPal changes an API | Edit each call | Upgrade the pinned package |
| Tests | Mocked axios | The SDK's own seam; assertions on the exact wire JSON |
| Cost | Nothing | About 19 MB in the Lambda package; about 0.14 s to load, once per container and only when PayPal is used |

## What runs on the SDK

| Flow step | SDK call |
|---|---|
| Customer pays for a booking (PayPal page) | `OrdersController.createOrder` (CAPTURE, payer-action link, save PayPal on first payment) |
| Seat re-checked, then money taken | `OrdersController.captureOrder` (idempotent: `PayPal-Request-Id`, `ORDER_ALREADY_CAPTURED` returns the existing capture) |
| Pay with saved PayPal (one tap, or the AI allowance) | `OrdersController.createOrder` with `vaultId` + `storedCredential` (CUSTOMER or MERCHANT), FraudNet `PayPal-Client-Metadata-Id` |
| Policy refund, partial refund, refund on a business's behalf | `PaymentsController.refundCapturedPayment` (with `PayPal-Auth-Assertion` for a connected business) |
| Owner looks a payment up (fee, net, refunds) | `OrdersController.getOrder`, `PaymentsController.getCapturedPayment`, `PaymentsController.getRefund` |
| Change or remove saved PayPal | `VaultController.createSetupToken`, `createPaymentToken`, `deletePaymentToken` |
| Memberships | `SubscriptionsController.createBillingPlan`, `createSubscription`, `getSubscription`, `cancelSubscription` |

Code: [`apps/lambda/src/services/payments/paypalSdk.js`](../apps/lambda/src/services/payments/paypalSdk.js) (the client) and [`paypal.js`](../apps/lambda/src/services/payments/paypal.js) (Flow's PayPal provider). On the **Under the hood** timeline, each of these steps shows `via: PayPal Server SDK (APIMatic)`.

**Flow's own REST calls, for the PayPal APIs outside the SDK:** Invoicing v2, Disputes, Catalog Products (the product behind a membership plan), Log in with PayPal, Partner Referrals and webhook signature checks.

## What the Context Plugin changed

The plugin is a set of skills that teach a coding agent this SDK, taken from the SDK's own source. Following them changed real decisions:

- **Timeout.** The SDK leaves the timeout to each app (its default, `timeout: 0`, means no limit). Following the plugin, Flow sets 15 s, so a slow PayPal call can't use up the Lambda's 29 seconds.
- **Retries.** They're off by default, and turning them on takes two fields (`maxNumberOfRetries` *and* `maximumRetryWaitTime`). Flow retries GETs and PUTs only (the SDK's default methods). POSTs carry a `PayPal-Request-Id` instead, so a retried capture or refund can't run twice.
- **One client per container.** It caches its OAuth token. Controllers are made per call. The SDK is required lazily (about 0.14 s, only when a request touches PayPal).
- **Errors.** `ApiError` keeps PayPal's own field names (`details[0].issue`, `debug_id`), on `.result` for typed errors and on the raw `.body` otherwise. Flow maps both to the same error the rest of the code already used, so callers didn't change. Network failures pass through untouched.
- **Tests.** The SDK ships no mocks. Its seam is a stub axios adapter passed through `unstable_httpClientOptions`, with retries off. [`paypalSdkStub.js`](../apps/lambda/src/__tests__/paypalSdkStub.js) answers with PayPal's real JSON, and the tests check the exact JSON the SDK sends: `purchase_units`, `stored_credential`, `PayPal-Auth-Assertion`, `billing_cycles` and so on.

## How it's checked

- **Live PayPal sandbox:** `scripts/paypal-sandbox-e2e.js` runs the SDK code against the real sandbox. It creates an order, the buyer approves it, it captures $40, a repeated capture returns the same capture, it refunds 60%, a repeated refund returns the same refund, and it reads the refund back.
- **Tests:** the SDK tests check the exact JSON PayPal receives.
- **Build:** the Lambda package loads all six handlers with the SDK (about 100 MB unzipped; the limit is 250).
- **Security:** the SDK added no npm audit findings. With axios at 1.21.0 and `crypto.randomUUID()` in place of `uuid`, the production package audits at **0**.

## Install the plugin

```bash
npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview
```

Then start with the `typescript-getting-started` skill (the TypeScript skills cover this JavaScript SDK too). If the installer can't read the repository, `git clone` it and run `npx context-plugins install ./server-sdk-context-plugin-preview` instead.

## Check a change against the sandbox

With your sandbox keys in `apps/lambda/.env`:

```bash
node apps/lambda/scripts/paypal-sandbox-e2e.js
```

It creates a real sandbox order, captures it, refunds part of it and reads everything back: every step that now runs through the SDK.
