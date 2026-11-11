# Alexa skill "Flow Bookings": setup

Free. Development mode needs no publishing, certification or license.

**The CLI route** (instead of the console steps below): `npm i -g ask-cli`, then `ask configure --no-browser` (sign in, paste the code; no AWS link), then `ask smapi create-skill-for-vendor` with the manifest *without* the endpoint, `set-interaction-model`, save the Skill ID and redeploy, `update-skill-manifest` with the endpoint, and `set-skill-enablement -g development`. The endpoint has to come after the redeploy: Alexa rejects a Lambda that doesn't trust the skill yet.

**Push changes to the skill** (manifest + model, every locale): `node apps/lambda/scripts/alexa-skill.js` (`--dry-run` prints the commands). The skill has five English locales (en-US, en-IN, en-GB, en-CA, en-AU) sharing one model, because an Alexa set to English (India) can't open an en-US-only skill: it answers "I'm not quite sure how to help you with that". Changes to `core/alexa.js` (like the "disconnect my account" intent) also need the API redeployed.

**Test from the command line:** `ask smapi simulate-skill -s <skill id> -g development --device-locale en-US --input-content "open flow bookings"`, then `ask smapi get-skill-simulation -s <skill id> -g development -i <id>`.

## 1. Create the skill (once, by hand in the console)

1. Sign in at **developer.amazon.com/alexa** (a free Amazon developer account), then **Alexa Skills Kit → Create Skill**.
   - Name: **Flow Bookings**
   - Locale: **English (US)**
   - Experience: Other; Model: **Custom**
   - Hosting: **Provision your own**
   - Template: start from scratch
2. **Interaction model.**
   - In **Build → Interaction Model → JSON Editor**, paste [`skill-package/interactionModels/custom/en-US.json`](skill-package/interactionModels/custom/en-US.json).
   - Press **Save**, then **Build skill**.
3. **Skill ID first.** In **Build → Endpoint**, choose **AWS Lambda ARN** and copy the **Skill ID** shown there. Save it, so AWS lets only this skill call Flow's function:
   ```bash
   MSYS_NO_PATHCONV=1 aws ssm put-parameter --region us-east-1 --name /flowhq/alexa/skillId --type String --value "amzn1.ask.skill.…"
   ```
   Then redeploy the API (`npm run deploy --workspace=apps/lambda`).
4. **Then the endpoint.** Paste the `flowhq-dev-alexa` function's ARN as the Default Region and press **Save Endpoints**. Find the ARN with:
   ```bash
   aws lambda get-function --function-name flowhq-dev-alexa --region us-east-1 --query Configuration.FunctionArn --output text
   ```

## 2. Try it

1. **Test** tab → set testing to **Development**.
2. On https://flowhq.vercel.app, start a session and open **Alexa** in the customer menu: it shows the code and turns to "Alexa is linked" by itself (Unlink is there too). The Voice assistant page shows the code as well.
3. Type or say:
   - "open flow bookings"
   - "my code is 1234" (your code)
   - "book me a haircut with Ana on Monday at 11 AM"
   - With saved PayPal within your AI allowance, it books and pays in one go. Check **Under the hood** and your Flow inbox.
4. **On a real device:** an Echo, or the Alexa phone app, signed in with the same Amazon account runs the development skill too.

## 3. Let others try it on their own Echo

**A beta test** lets other people use the development skill on their own Echo or Alexa app. Amazon has no public beta link, so testers add themselves:
- On the **Alexa** page, the **"Use your own Echo or Alexa app"** box takes the email of their Amazon account.
- `core/alexaBeta.js` adds it through Amazon's Skill Management API (`POST /v1/skills/{id}/betaTest/testers/add`) and shows the invitation link (`GET …/betaTest` → `invitationUrl`).
- Flow keeps only a masked copy.
- It acts as the skill's developer with the ASK CLI's refresh token in SSM `/flowhq/alexa/lwaRefreshToken`. Without it, the box doesn't show.
- **If the token stops working** (e.g. after signing in again elsewhere), run `ask configure` again and copy the new refresh token from `~/.ask/cli_config` (`profiles.default.token.refresh_token`) into that parameter, then redeploy.
- **Adding someone by hand:** `ask smapi add-testers-to-beta-test -s <skill id> --testers '[{"emailId":"name@example.com"}]'`. List with `ask smapi get-list-of-testers -s <skill id>`.
- Amazon's own invitation email often doesn't arrive (it's treated as marketing mail), so the page's link is the reliable way. A tester opens it on their phone and taps Accept, then links with their session's code.
- The skill icons (Amazon needs them for a beta) are `apps/dashboard/public/alexa/icon-108.png` and `icon-512.png`, served from flowhq.vercel.app.

## How it works

- `apps/lambda/src/handlers/alexa.js` is the Lambda the skill calls.
- `apps/lambda/src/core/alexa.js` maps Alexa's requests to Flow Voice (`core/voice.js`): the same AI, tools, PayPal and timeline as the browser voice assistant.
- Linking is the 4-digit code from `GET /demo/alexa`.
- Alexa waits about 8 seconds, so Flow says "One moment" (a progressive response) while the AI works.
- **Long turns:** a booking with payment can take longer than the 8 seconds Alexa waits. So the AI turn runs in a background (asynchronous) run of the same function: done within 6 seconds, Alexa answers as usual; longer, Alexa says "I'm on it… say go on" and the next turn gets the answer. One turn at a time per Alexa user, so nothing is booked twice. It needs `lambda:InvokeFunction` on itself (serverless.yml) and the function's timeout is 30 s.
- **On Under the hood:** "Alexa heard the customer" (what Alexa passed on), then "Alexa replied" (what it said).
