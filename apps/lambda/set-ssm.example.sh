#!/usr/bin/env bash
# Flow — load all secrets into AWS SSM Parameter Store (region ap-south-1).
#
# SETUP:  cp set-ssm.example.sh set-ssm.sh, fill in the REPLACE_ values, then run:
#             bash set-ssm.sh
#         set-ssm.sh is gitignored — never commit real credentials.
#
# Re-running overwrites (--overwrite). SecureString = encrypted at rest.

set -euo pipefail
REGION=ap-south-1

put()  { aws ssm put-parameter --region "$REGION" --name "$1" --value "$2" --type String       --overwrite >/dev/null && echo "  set $1"; }
puts() { aws ssm put-parameter --region "$REGION" --name "$1" --value "$2" --type SecureString --overwrite >/dev/null && echo "  set $1 (secure)"; }

# ── REQUIRED ──────────────────────────────────────────────────────────────────
# Infra
put  /flow/kms/keyId            "REPLACE_KMS_KEY_ID"     # from: aws kms create-key --region ap-south-1
put  /flow/kms/keyArn           "REPLACE_KMS_KEY_ARN"    # Arn of that same key — serverless.yml reads it for the IAM policy
puts /flow/linkSecret           "$(openssl rand -hex 32)"          # auto-generated, leave as-is
put  /flow/redis/url            "REPLACE_UPSTASH_REDIS_URL"        # rediss://default:<password>@<host>:6379
put  /flow/alerts/snsTopicArn   "REPLACE_SNS_TOPIC_ARN"            # from: aws sns create-topic --name flow-alerts

# AI (required): one provider, Google Gemini, for chat, media, speech and embeddings
puts /flow/google/apiKey        "REPLACE_GOOGLE_KEY"     # aistudio.google.com/apikey (starts AIza)
# Optional: only if you switch AI_PROVIDER to anthropic (put /flow/ai/provider "anthropic")
# puts /flow/anthropic/apiKey     "REPLACE_ANTHROPIC_KEY"   # console.anthropic.com → API Keys

# Payments — Cashfree (use sandbox keys to test)
puts /flow/cashfree/appId         "REPLACE_CASHFREE_APP_ID"
puts /flow/cashfree/secretKey     "REPLACE_CASHFREE_SECRET"
puts /flow/cashfree/webhookSecret "REPLACE_CASHFREE_WEBHOOK_SECRET"
put  /flow/cashfree/env           "sandbox"                        # flip to 'production' for live

# WhatsApp — Meta (needed for Stage 2; dummy ok for Stage 1)
put  /flow/meta/appId           "REPLACE_META_APP_ID"
puts /flow/meta/appSecret       "REPLACE_META_APP_SECRET"
put  /flow/meta/verifyToken     "$(openssl rand -hex 16)"          # reuse this value in the Meta webhook config

# ── OPTIONAL (have safe defaults — set only if you use the feature) ────────────
puts /flow/sarvam/apiKey        "REPLACE_SARVAM_KEY"               # voice STT/TTS
put  /flow/ses/fromEmail        "no-reply@yourdomain.com"          # SES-verified sender for OTP email
# Voice / Retell / templates / provider OAuth all default to '' — add later as needed.

echo "Done. Now: serverless deploy --stage dev"
