-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DORMANT', 'QUARANTINED', 'DELETED');

-- CreateEnum
CREATE TYPE "LineType" AS ENUM ('MOBILE', 'LANDLINE', 'VOIP', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BindingStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'RELEASED');

-- CreateEnum
CREATE TYPE "RoleFlag" AS ENUM ('LOGIN', 'RECOVERY', 'NOTIFICATIONS');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('PASSKEY', 'FIDO2_HARDWARE_KEY', 'RECOVERY_CODE', 'TOTP', 'DEVICE_KEY');

-- CreateEnum
CREATE TYPE "AttestationType" AS ENUM ('NONE', 'APPLE_APP_ATTEST', 'GOOGLE_PLAY_INTEGRITY', 'FIDO2');

-- CreateEnum
CREATE TYPE "TrustLevel" AS ENUM ('UNVERIFIED', 'VERIFIED', 'TRUSTED', 'HIGH_TRUST');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'VOICE', 'WHATSAPP', 'PUSH');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('PENDING', 'DELIVERED', 'VERIFIED', 'EXPIRED', 'FAILED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RecoveryTier" AS ENUM ('SAME_NUMBER_OTP', 'TRUSTED_DEVICE_APPROVAL', 'RECOVERY_CODE', 'SECONDARY_NUMBER', 'TRUSTED_CONTACT', 'IDENTITY_VERIFICATION');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('INITIATED', 'PENDING_APPROVAL', 'WAITING_PERIOD', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('SECURITY_ALERT', 'TRANSACTIONAL', 'RECEIPT_INVOICE', 'MARKETING', 'LEGAL_NOTICE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageCategory" AS ENUM ('AUTH', 'SECURITY', 'TRANSACTION', 'BILLING', 'MARKETING', 'LEGAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('UNREAD', 'READ', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('IN_APP', 'PUSH', 'SMS', 'WHATSAPP', 'VOICE', 'EMAIL_PROXY');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'BOUNCED', 'OPT_OUT');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('AUTHENTICATION', 'SECURITY_ALERTS', 'TRANSACTIONAL', 'MARKETING', 'LEGAL_NOTICES', 'ANALYTICS', 'CARRIER_LOOKUP', 'SIM_SWAP_CHECK');

-- CreateEnum
CREATE TYPE "WhatsAppCategory" AS ENUM ('AUTHENTICATION', 'UTILITY', 'MARKETING');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'ENDED');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('LOGIN_ATTEMPT', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'OTP_REQUESTED', 'OTP_VERIFIED', 'OTP_FAILED', 'REGISTRATION', 'NUMBER_ADDED', 'NUMBER_CHANGED', 'NUMBER_REMOVED', 'PASSKEY_ENROLLED', 'PASSKEY_REVOKED', 'DEVICE_TRUSTED', 'DEVICE_REVOKED', 'RECOVERY_INITIATED', 'RECOVERY_COMPLETED', 'RECOVERY_CANCELLED', 'SIM_SWAP_DETECTED', 'SESSION_REVOKED', 'SETTINGS_CHANGED', 'CONSENT_CHANGED', 'DATA_EXPORT', 'DATA_DELETION', 'SUSPICIOUS_ACTIVITY', 'RATE_LIMIT_HIT', 'SMS_PUMPING_DETECTED');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SignalSource" AS ENUM ('CARRIER_API', 'AGGREGATOR_LOOKUP', 'HEURISTIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SimSwapSignalType" AS ENUM ('SIM_SWAP_DETECTED', 'CARRIER_CHANGE', 'RECENT_PORT', 'NEW_DEVICE_OTP', 'MULTIPLE_ACCOUNTS_DEVICE', 'VOIP_DISPOSABLE', 'RISK_SCORE_HIGH');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneBinding" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "e164Hash" TEXT NOT NULL,
    "e164Encrypted" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "carrier" TEXT,
    "lineType" "LineType" NOT NULL DEFAULT 'UNKNOWN',
    "portStatus" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "status" "BindingStatus" NOT NULL DEFAULT 'PENDING',
    "roleFlags" "RoleFlag"[] DEFAULT ARRAY['LOGIN']::"RoleFlag"[],
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "carrierSnapshot" JSONB,
    "simSwapCheckedAt" TIMESTAMP(3),
    "simSwapRiskScore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "CredentialType" NOT NULL,
    "publicKey" TEXT NOT NULL,
    "credentialId" TEXT,
    "attestation" JSONB,
    "aaguid" TEXT,
    "signCount" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "deviceKeyHash" TEXT NOT NULL,
    "attestationType" "AttestationType",
    "attestationData" JSONB,
    "platform" TEXT,
    "platformVersion" TEXT,
    "appVersion" TEXT,
    "name" TEXT,
    "isTrusted" BOOLEAN NOT NULL DEFAULT false,
    "trustLevel" "TrustLevel" NOT NULL DEFAULT 'UNVERIFIED',
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenIp" TEXT,
    "pushToken" TEXT,
    "pushTokenType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "deviceId" TEXT,
    "accessTokenHash" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "phoneBindingId" TEXT,
    "e164Hash" TEXT NOT NULL,
    "channel" "OtpChannel" NOT NULL,
    "hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "deviceId" TEXT,
    "deviceFingerprint" TEXT,
    "ipAddress" TEXT,
    "countryPrefix" TEXT,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batchId" TEXT NOT NULL,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryAttempt" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tier" "RecoveryTier" NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'INITIATED',
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "waitingUntil" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "RecoveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedContact" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactAccountId" TEXT NOT NULL,
    "contactName" TEXT,
    "contactHandle" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "threshold" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TrustedContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "MessageType" NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "status" "MessageStatus" NOT NULL DEFAULT 'UNREAD',
    "readAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "sourceId" TEXT,
    "sourceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerId" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,
    "cost" DECIMAL(10,4),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "channel" "DeliveryChannel",
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "version" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "WhatsAppCategory" NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en_US',
    "header" TEXT,
    "body" TEXT NOT NULL,
    "footer" TEXT,
    "buttons" JSONB,
    "status" "TemplateStatus" NOT NULL DEFAULT 'PENDING',
    "providerId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "phoneBindingId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProxyEmail" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "localPart" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "vendorId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProxyEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorMapping" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "vendorSub" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "eventType" "AuditEventType" NOT NULL,
    "severity" "AuditSeverity" NOT NULL DEFAULT 'INFO',
    "description" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "deviceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimSwapSignal" (
    "id" TEXT NOT NULL,
    "phoneBindingId" TEXT NOT NULL,
    "source" "SignalSource" NOT NULL,
    "signal" "SimSwapSignalType" NOT NULL,
    "confidence" INTEGER NOT NULL,
    "details" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actedUpon" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SimSwapSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountryConfig" (
    "id" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dailySpendCap" DECIMAL(10,2),
    "monthlySpendCap" DECIMAL(10,2),
    "requiresSenderIdRegistration" BOOLEAN NOT NULL DEFAULT false,
    "requiresDltRegistration" BOOLEAN NOT NULL DEFAULT false,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CountryConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConversionMetric" (
    "id" TEXT NOT NULL,
    "countryPrefix" TEXT NOT NULL,
    "carrier" TEXT,
    "date" DATE NOT NULL,
    "sendsCount" INTEGER NOT NULL DEFAULT 0,
    "verifiesCount" INTEGER NOT NULL DEFAULT 0,
    "conversionRate" DOUBLE PRECISION NOT NULL,
    "cost" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsConversionMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_handle_key" ON "Account"("handle");

-- CreateIndex
CREATE INDEX "Account_status_idx" ON "Account"("status");

-- CreateIndex
CREATE INDEX "Account_handle_idx" ON "Account"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneBinding_e164Hash_key" ON "PhoneBinding"("e164Hash");

-- CreateIndex
CREATE INDEX "PhoneBinding_accountId_idx" ON "PhoneBinding"("accountId");

-- CreateIndex
CREATE INDEX "PhoneBinding_status_idx" ON "PhoneBinding"("status");

-- CreateIndex
CREATE INDEX "PhoneBinding_e164Hash_idx" ON "PhoneBinding"("e164Hash");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_credentialId_key" ON "Credential"("credentialId");

-- CreateIndex
CREATE INDEX "Credential_accountId_idx" ON "Credential"("accountId");

-- CreateIndex
CREATE INDEX "Credential_credentialId_idx" ON "Credential"("credentialId");

-- CreateIndex
CREATE INDEX "Credential_type_idx" ON "Credential"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceKey_key" ON "Device"("deviceKey");

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceKeyHash_key" ON "Device"("deviceKeyHash");

-- CreateIndex
CREATE INDEX "Device_accountId_idx" ON "Device"("accountId");

-- CreateIndex
CREATE INDEX "Device_deviceKeyHash_idx" ON "Device"("deviceKeyHash");

-- CreateIndex
CREATE INDEX "Device_isTrusted_idx" ON "Device"("isTrusted");

-- CreateIndex
CREATE UNIQUE INDEX "Session_accessTokenHash_key" ON "Session"("accessTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_accountId_idx" ON "Session"("accountId");

-- CreateIndex
CREATE INDEX "Session_deviceId_idx" ON "Session"("deviceId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Session_refreshTokenHash_idx" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "OtpChallenge_e164Hash_idx" ON "OtpChallenge"("e164Hash");

-- CreateIndex
CREATE INDEX "OtpChallenge_status_idx" ON "OtpChallenge"("status");

-- CreateIndex
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_phoneBindingId_idx" ON "OtpChallenge"("phoneBindingId");

-- CreateIndex
CREATE INDEX "RecoveryCode_accountId_idx" ON "RecoveryCode"("accountId");

-- CreateIndex
CREATE INDEX "RecoveryCode_batchId_idx" ON "RecoveryCode"("batchId");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_accountId_idx" ON "RecoveryAttempt"("accountId");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_status_idx" ON "RecoveryAttempt"("status");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_initiatedAt_idx" ON "RecoveryAttempt"("initiatedAt");

-- CreateIndex
CREATE INDEX "TrustedContact_accountId_idx" ON "TrustedContact"("accountId");

-- CreateIndex
CREATE INDEX "TrustedContact_contactAccountId_idx" ON "TrustedContact"("contactAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedContact_accountId_contactAccountId_key" ON "TrustedContact"("accountId", "contactAccountId");

-- CreateIndex
CREATE INDEX "InboxMessage_accountId_status_idx" ON "InboxMessage"("accountId", "status");

-- CreateIndex
CREATE INDEX "InboxMessage_accountId_category_idx" ON "InboxMessage"("accountId", "category");

-- CreateIndex
CREATE INDEX "InboxMessage_accountId_createdAt_idx" ON "InboxMessage"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "InboxMessage_sourceId_sourceType_idx" ON "InboxMessage"("sourceId", "sourceType");

-- CreateIndex
CREATE INDEX "NotificationDelivery_messageId_idx" ON "NotificationDelivery"("messageId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_channel_status_idx" ON "NotificationDelivery"("channel", "status");

-- CreateIndex
CREATE INDEX "NotificationDelivery_providerId_idx" ON "NotificationDelivery"("providerId");

-- CreateIndex
CREATE INDEX "Consent_accountId_idx" ON "Consent"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_accountId_purpose_channel_key" ON "Consent"("accountId", "purpose", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_name_key" ON "WhatsAppTemplate"("name");

-- CreateIndex
CREATE INDEX "WhatsAppTemplate_category_idx" ON "WhatsAppTemplate"("category");

-- CreateIndex
CREATE INDEX "WhatsAppTemplate_status_idx" ON "WhatsAppTemplate"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppSession_sessionId_key" ON "WhatsAppSession"("sessionId");

-- CreateIndex
CREATE INDEX "WhatsAppSession_accountId_idx" ON "WhatsAppSession"("accountId");

-- CreateIndex
CREATE INDEX "WhatsAppSession_sessionId_idx" ON "WhatsAppSession"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppSession_phoneBindingId_key" ON "WhatsAppSession"("phoneBindingId");

-- CreateIndex
CREATE INDEX "ProxyEmail_accountId_idx" ON "ProxyEmail"("accountId");

-- CreateIndex
CREATE INDEX "ProxyEmail_vendor_idx" ON "ProxyEmail"("vendor");

-- CreateIndex
CREATE UNIQUE INDEX "ProxyEmail_localPart_domain_key" ON "ProxyEmail"("localPart", "domain");

-- CreateIndex
CREATE INDEX "VendorMapping_accountId_idx" ON "VendorMapping"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorMapping_accountId_vendor_key" ON "VendorMapping"("accountId", "vendor");

-- CreateIndex
CREATE UNIQUE INDEX "VendorMapping_vendor_vendorSub_key" ON "VendorMapping"("vendor", "vendorSub");

-- CreateIndex
CREATE INDEX "AuditLog_accountId_idx" ON "AuditLog"("accountId");

-- CreateIndex
CREATE INDEX "AuditLog_eventType_idx" ON "AuditLog"("eventType");

-- CreateIndex
CREATE INDEX "AuditLog_severity_idx" ON "AuditLog"("severity");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "SimSwapSignal_phoneBindingId_idx" ON "SimSwapSignal"("phoneBindingId");

-- CreateIndex
CREATE INDEX "SimSwapSignal_detectedAt_idx" ON "SimSwapSignal"("detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitBucket_key_key" ON "RateLimitBucket"("key");

-- CreateIndex
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CountryConfig_countryCode_key" ON "CountryConfig"("countryCode");

-- CreateIndex
CREATE INDEX "SmsConversionMetric_date_idx" ON "SmsConversionMetric"("date");

-- CreateIndex
CREATE INDEX "SmsConversionMetric_conversionRate_idx" ON "SmsConversionMetric"("conversionRate");

-- CreateIndex
CREATE UNIQUE INDEX "SmsConversionMetric_countryPrefix_carrier_date_key" ON "SmsConversionMetric"("countryPrefix", "carrier", "date");

-- AddForeignKey
ALTER TABLE "PhoneBinding" ADD CONSTRAINT "PhoneBinding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_phoneBindingId_fkey" FOREIGN KEY ("phoneBindingId") REFERENCES "PhoneBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedContact" ADD CONSTRAINT "TrustedContact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "InboxMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppSession" ADD CONSTRAINT "WhatsAppSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppSession" ADD CONSTRAINT "WhatsAppSession_phoneBindingId_fkey" FOREIGN KEY ("phoneBindingId") REFERENCES "PhoneBinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProxyEmail" ADD CONSTRAINT "ProxyEmail_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorMapping" ADD CONSTRAINT "VendorMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimSwapSignal" ADD CONSTRAINT "SimSwapSignal_phoneBindingId_fkey" FOREIGN KEY ("phoneBindingId") REFERENCES "PhoneBinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
