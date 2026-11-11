# Flow — load all secrets into AWS SSM Parameter Store (region ap-south-1).
#
# SETUP:  copy this file to set-ssm.ps1, fill in the REPLACE_ values, then run:
#             .\set-ssm.ps1
#         set-ssm.ps1 is gitignored — never commit real credentials.
#
# Re-running overwrites. SecureString = encrypted at rest.

$ErrorActionPreference = 'Stop'
$REGION = "ap-south-1"

function put($name, $value) {
    if ([string]::IsNullOrWhiteSpace($value) -or $value -eq "REPLACE" -or $value -match "REPLACE_") {
        Write-Host "Skipping $name (still has REPLACE placeholder)" -ForegroundColor Yellow
        return
    }
    aws ssm put-parameter --region "$REGION" --name "$name" --value "$value" --type String --overwrite | Out-Null
    Write-Host "  set $name"
}

function puts($name, $value) {
    if ([string]::IsNullOrWhiteSpace($value) -or $value -eq "REPLACE" -or $value -match "REPLACE_") {
        Write-Host "Skipping $name (still has REPLACE placeholder)" -ForegroundColor Yellow
        return
    }
    aws ssm put-parameter --region "$REGION" --name "$name" --value "$value" --type SecureString --overwrite | Out-Null
    Write-Host "  set $name (secure)"
}

# ── REQUIRED ──────────────────────────────────────────────────────────────────
# Infra
put  "/flow/kms/keyId"            "REPLACE_KMS_KEY_ID"    # from: aws kms create-key --region ap-south-1
put  "/flow/kms/keyArn"           "REPLACE_KMS_KEY_ARN"   # the Arn of that same key — serverless.yml reads it for the IAM policy
puts "/flow/linkSecret"           $([guid]::NewGuid().ToString("N"))   # auto-generated, leave as-is
put  "/flow/redis/url"            "REPLACE_UPSTASH_REDIS_URL"          # rediss://default:<password>@<host>:6379
put  "/flow/alerts/snsTopicArn"   "REPLACE_SNS_TOPIC_ARN"              # from: aws sns create-topic --name flow-alerts

# AI (required): one provider, Google Gemini, for chat, media, speech and embeddings
puts /flow/google/apiKey        "REPLACE_GOOGLE_KEY"      # aistudio.google.com/apikey (starts AIza)
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
put  "/flow/meta/verifyToken"     $([guid]::NewGuid().ToString("N"))  # reuse this value in the Meta webhook config

# ── OPTIONAL ──────────────────────────────────────────────────────────────────
puts /flow/sarvam/apiKey        "REPLACE_SARVAM_KEY"               # voice STT/TTS
put  "/flow/ses/fromEmail"        "no-reply@yourdomain.com"        # SES-verified sender for OTP email
# Voice / Retell / templates / provider OAuth all default to '' — add later as needed.

Write-Host "Done! If you didn't see any yellow skipping warnings, run: serverless deploy --stage dev" -ForegroundColor Green
