// src/services/otp.ts
import { prisma } from '../lib/prisma';
import { generateOtp, hashOtp, timingSafeEqual } from '../lib/crypto';
import { sendSmsOtp } from './sms';
import { sendVoiceOtp, storeOtpForVoice } from './voice';
import { notificationQueue } from '../queues/notification.queue';
import { detectSimSwapSignals } from './phone';

const OTP_TTL = 300; // 5 minutes
const MAX_ATTEMPTS = 5;
const JWT_SECRET = process.env.JWT_SECRET!;

export interface OtpChallengeResult {
  challengeId: string;
  otp: string; // Only returned here for delivery, never stored
  channel: OtpChannel;
  expiresAt: Date;
}

export type OtpChannel = 'SMS' | 'VOICE' | 'PUSH';

export interface VerifyOtpResult {
  ok: boolean;
  phoneBindingId?: string;
  accountId?: string;
  reason?: 'EXPIRED_OR_INVALID' | 'MAX_ATTEMPTS' | 'MISMATCH' | 'SIM_SWAP_REQUIRES_STEPUP';
  attemptsLeft?: number;
  requiresStepUp?: boolean;
  stepUpMethods?: string[];
}

/**
 * Create OTP challenge with rate limiting and SIM swap detection
 */
export async function createChallenge(
  phoneE164: string,
  preferredChannel: OtpChannel = 'SMS',
  options: {
    deviceId?: string;
    deviceFingerprint?: string;
    ipAddress?: string;
    countryPrefix?: string;
    purpose?: 'LOGIN' | 'REGISTER' | 'RECOVERY' | 'NUMBER_CHANGE' | 'VERIFY_NUMBER';
  } = {}
): Promise<OtpChallengeResult> {
  const { deviceId, deviceFingerprint, ipAddress, countryPrefix, purpose = 'LOGIN' } = options;
  
  // Rate limiting per phone (3 per 10 min, 10 per day)
  await checkRateLimit(`phone:${phoneE164}:10m`, 3, 600);
  await checkRateLimit(`phone:${phoneE164}:24h`, 10, 86400);
  
  // Rate limiting per IP
  if (ipAddress) {
    await checkRateLimit(`ip:${ipAddress}:10m`, 10, 600);
    await checkRateLimit(`ip:${ipAddress}:24h`, 50, 86400);
  }
  
  // Rate limiting per device
  if (deviceId) {
    await checkRateLimit(`device:${deviceId}:10m`, 5, 600);
  }
  
  // Rate limiting per country prefix
  if (countryPrefix) {
    await checkRateLimit(`country:${countryPrefix}:1m`, 100, 60);
  }
  
  // Global rate limit
  await checkRateLimit('global:1s', 1000, 1);
  
  // Find or create phone binding
  const e164Hash = require('../lib/crypto').createBlindIndex(phoneE164);
  let phoneBinding = await prisma.phoneBinding.findUnique({
    where: { e164Hash },
  });
  
  let phoneBindingId: string | undefined;
  let isNewBinding = false;
  
  if (!phoneBinding) {
    if (purpose === 'REGISTER') {
      // For registration, don't create phone binding yet - will be created in completeRegistration
      // Just store phone number in challenge metadata
      isNewBinding = true;
    } else {
      // Pre-registration challenge - no binding yet
      isNewBinding = true;
    }
  } else {
    phoneBindingId = phoneBinding.id;
    
    // Invalidate any prior pending challenge for this binding
    await prisma.otpChallenge.updateMany({
      where: { phoneBindingId, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
    
    // SIM swap detection for existing bindings
    if (purpose !== 'REGISTER') {
      const { riskScore, signals } = await detectSimSwapSignals(phoneBindingId, deviceId, ipAddress);
      
      // If high risk, restrict SMS/Voice/WhatsApp channels
      if (riskScore >= 70 && ['SMS', 'VOICE', 'WHATSAPP'].includes(preferredChannel)) {
        // Log but don't block - will require step-up at verification
        console.warn(`High SIM swap risk (${riskScore}) for ${phoneE164}, channel: ${preferredChannel}`);
      }
    }
  }
  
  // Generate challenge
  const challengeId = require('crypto').randomUUID();
  const otp = generateOtp();
  const otpHash = hashOtp(otp, challengeId, JWT_SECRET);
  const expiresAt = new Date(Date.now() + OTP_TTL * 1000);
  
  // Determine channel based on binding and availability
  const channel = await selectChannel(phoneBinding, preferredChannel);
  
  // Store challenge
  await prisma.otpChallenge.create({
    data: {
      id: challengeId,
      phoneBindingId,
      e164Hash,
      channel,
      hash: otpHash,
      maxAttempts: MAX_ATTEMPTS,
      deviceId,
      deviceFingerprint,
      ipAddress,
      countryPrefix: countryPrefix || phoneE164.substring(0, 3),
      status: 'PENDING',
      expiresAt,
      metadata: purpose === 'REGISTER' ? { phoneE164 } : undefined,
    },
  });
  
  // Send OTP via selected channel
  await deliverOtp(channel, phoneE164, otp, challengeId);
  
  // Schedule delivery check
  await notificationQueue.add('otp-delivery-check', { challengeId, phoneE164 }, { delay: 25000 });
  
  return { challengeId, otp, channel, expiresAt };
}

/**
 * Select best delivery channel based on binding and availability
 */
async function selectChannel(
  binding: { id: string; lineType: string; carrier?: string | null } | null,
  preferred: OtpChannel
): Promise<OtpChannel> {
  // If no binding (pre-registration), use preferred or default
  if (!binding) return preferred;
  
  // For landlines, prefer voice
  if (binding.lineType === 'LANDLINE') {
    if (preferred === 'VOICE') return 'VOICE';
    return 'VOICE'; // Force voice for landlines
  }
  
  // Default: SMS
  return preferred;
}

/**
 * Deliver OTP via selected channel
 */
async function deliverOtp(channel: OtpChannel, phoneE164: string, otp: string, challengeId: string) {
  switch (channel) {
    case 'SMS':
      await sendSmsOtp(phoneE164, otp);
      break;
    case 'VOICE':
      await sendVoiceOtp(phoneE164, challengeId);
      await storeOtpForVoice(challengeId, otp);
      break;
    case 'PUSH':
      // Push would go to app, not phone number directly
      throw new Error('PUSH channel requires account/device context');
  }
  
  // Update challenge status
  await prisma.otpChallenge.update({
    where: { id: challengeId },
    data: { status: 'DELIVERED' },
  });
}

/**
 * Verify OTP with SIM swap step-up logic
 */
export async function verifyOtp(
  challengeId: string,
  submittedOtp: string,
  options: { allowAlreadyVerified?: boolean; stepUpProof?: { method: string; code: string } } = {}
): Promise<VerifyOtpResult> {
  const challenge = await prisma.otpChallenge.findUnique({
    where: { id: challengeId },
    include: { phoneBinding: true },
  });
  
  if (!challenge) {
    return { ok: false, reason: 'EXPIRED_OR_INVALID' };
  }
  
  // A challenge may already be VERIFIED when the flow spans two requests
  // (e.g. /phone/verify proves possession, then /register/complete finishes
  // the sign-up). Only permit that when explicitly requested, and the hash
  // check below still applies, so the caller must still know the OTP.
  const acceptableStatus =
    challenge.status === 'PENDING' ||
    challenge.status === 'DELIVERED' ||
    (options.allowAlreadyVerified === true && challenge.status === 'VERIFIED');
  
  if (!acceptableStatus) {
    return { ok: false, reason: 'EXPIRED_OR_INVALID' };
  }
  
  if (challenge.expiresAt < new Date()) {
    await prisma.otpChallenge.update({
      where: { id: challengeId },
      data: { status: 'EXPIRED' },
    });
    return { ok: false, reason: 'EXPIRED_OR_INVALID' };
  }
  
  if (challenge.attempts >= challenge.maxAttempts) {
    await prisma.otpChallenge.update({
      where: { id: challengeId },
      data: { status: 'FAILED' },
    });
    return { ok: false, reason: 'MAX_ATTEMPTS' };
  }
  
  const expectedHash = hashOtp(submittedOtp, challengeId, JWT_SECRET);
  
  if (!timingSafeEqual(expectedHash, challenge.hash)) {
    await prisma.otpChallenge.update({
      where: { id: challengeId },
      data: { attempts: { increment: 1 } },
    });
    return { 
      ok: false, 
      reason: 'MISMATCH', 
      attemptsLeft: challenge.maxAttempts - challenge.attempts - 1 
    };
  }
  
  // SIM swap step-up gate. Evaluated BEFORE the challenge is marked VERIFIED
  // so a rejected attempt leaves the OTP usable for a retry with a second factor.
  let requiresStepUp = false;
  let stepUpMethods: string[] = [];
  
  if (challenge.phoneBindingId) {
    const { riskScore } = await detectSimSwapSignals(challenge.phoneBindingId, challenge.deviceId ?? undefined, challenge.ipAddress ?? undefined);
    
    if (riskScore >= 70 && ['SMS', 'VOICE'].includes(challenge.channel)) {
      requiresStepUp = true;
      stepUpMethods = ['PASSKEY', 'RECOVERY_CODE', 'TRUSTED_DEVICE', 'HARDWARE_KEY'];
    }
  }
  
  if (requiresStepUp) {
    let satisfied = false;
    if (options.stepUpProof?.method === 'RECOVERY_CODE' && options.stepUpProof.code) {
      // Imported lazily to avoid a module cycle (auth.ts imports this file).
      const { verifyRecoveryCode } = await import('./auth');
      const accountId = (challenge as any).phoneBinding?.accountId;
      satisfied = !!accountId && await verifyRecoveryCode(accountId, options.stepUpProof.code);
    }
    
    if (!satisfied) {
      // ok MUST be false here: the route only checks requiresStepUp when
      // !ok, so returning ok:true silently skipped the whole gate.
      return {
        ok: false,
        reason: 'SIM_SWAP_REQUIRES_STEPUP',
        requiresStepUp: true,
        stepUpMethods,
        phoneBindingId: challenge.phoneBindingId ?? undefined,
        accountId: (challenge as any).phoneBinding?.accountId ?? undefined,
      };
    }
  }
  
  // Success - consume the challenge
  await prisma.otpChallenge.update({
    where: { id: challengeId },
    data: { status: 'VERIFIED', verifiedAt: new Date() },
  });
  
  return {
    ok: true,
    phoneBindingId: challenge.phoneBindingId ?? undefined,
    accountId: (challenge as any).phoneBinding?.accountId ?? undefined,
    requiresStepUp: false,
    stepUpMethods: [],
  };
}

/**
 * Request fallback channel (SMS -> Voice -> WhatsApp)
 */
export async function requestFallbackChannel(
  challengeId: string,
  newChannel: OtpChannel
): Promise<OtpChallengeResult> {
  const challenge = await prisma.otpChallenge.findUnique({
    where: { id: challengeId },
  });
  
  if (!challenge || challenge.status === 'VERIFIED') {
    throw new Error('INVALID_CHALLENGE');
  }
  
  // Revoke old challenge
  await prisma.otpChallenge.update({
    where: { id: challengeId },
    data: { status: 'REVOKED' },
  });
  
  // Get phone number from challenge's e164Hash (we'd need to decrypt or store separately)
  // For fallback, we'd need the actual phone number - this is a simplified version
  
  throw new Error('Fallback requires phone number - use createChallenge with new channel');
}

/**
 * Rate limiting with Redis-backed buckets
 */
// The implementation now lives in lib/rate-limit.ts so every caller (OTP, SMS
// sending, ...) shares one correct fixed-window implementation. See the note
// there about the window-rollover bug this replaces.
import { assertWithinRateLimit as checkRateLimit } from '../lib/rate-limit';

/**
 * Get challenge info (for debugging/admin)
 */
export async function getChallengeInfo(challengeId: string) {
  return prisma.otpChallenge.findUnique({
    where: { id: challengeId },
    include: { phoneBinding: { include: { account: true } } },
  });
}