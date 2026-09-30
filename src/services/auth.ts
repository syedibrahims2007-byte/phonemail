// src/services/auth.ts
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { generateSecureToken, hashOtp } from '../lib/crypto';
import { createPhoneBinding, verifyPhoneBinding, getDecryptedPhone, detectSimSwapSignals, getPrimaryPhone } from './phone';
import { createChallenge, verifyOtp, VerifyOtpResult } from './otp';
import { sendPush } from './push';

const JWT_SECRET = process.env.JWT_SECRET!;
const ACCESS_TOKEN_TTL = '15m'; // 15 minutes
const REFRESH_TOKEN_TTL = '30d'; // 30 days
const REFRESH_TOKEN_ROTATION_TTL = '7d'; // Rotate after 7 days

// Refresh tokens are looked up by hash alone - the account is not known when
// the hash is computed, since the hash IS the lookup key. Creation and lookup
// must therefore salt identically: they previously used `accountId` and
// `'refresh'` respectively, so the digests never matched and every
// /auth/refresh call failed with INVALID_REFRESH_TOKEN. The token is 32 bytes
// of CSPRNG output, so a constant salt costs nothing in terms of security.
const REFRESH_TOKEN_SALT = 'session-refresh';

// Shared lazy Redis connection. Instantiating a client per call leaked
// sockets because nothing ever closed them.
let _redis: any = null;
function getRedisClient() {
  if (!_redis) {
    const Redis = require('ioredis').default;
    _redis = new Redis(process.env.REDIS_URL!);
    _redis.on('error', (err: Error) => console.error('[Redis] error:', err.message));
  }
  return _redis;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface DeviceInfo {
  deviceId: string;
  deviceKey: string; // Public key
  platform?: string;
  platformVersion?: string;
  appVersion?: string;
  name?: string;
  attestationType?: 'NONE' | 'APPLE_APP_ATTEST' | 'GOOGLE_PLAY_INTEGRITY' | 'FIDO2';
  attestationData?: any;
}

/**
 * Register new account with phone number
 */
export async function initiateRegistration(
  phoneE164: string,
  options: {
    displayName?: string;
    handle?: string;
    deviceInfo?: DeviceInfo;
    preferredChannel?: 'SMS' | 'VOICE';
    carrierInfo?: any;
  } = {}
) {
  const { displayName, handle, deviceInfo, preferredChannel = 'SMS', carrierInfo } = options;
  
  // Check if number already bound to active account
  const e164Hash = require('../lib/crypto').createBlindIndex(phoneE164);
  const existingBinding = await prisma.phoneBinding.findUnique({ where: { e164Hash } });
  
  if (existingBinding?.status === 'ACTIVE') {
    throw new Error('NUMBER_ALREADY_REGISTERED');
  }
  
  // Create OTP challenge for verification
  const challenge = await createChallenge(phoneE164, preferredChannel, {
    purpose: 'REGISTER',
    deviceId: deviceInfo?.deviceId,
    deviceFingerprint: deviceInfo?.deviceId,
  });
  
  // Store registration intent in Redis for verification callback
  const redisClient = getRedisClient();
  await redisClient.setex(
    `register:${challenge.challengeId}`,
    300,
    JSON.stringify({ displayName, handle, deviceInfo, carrierInfo })
  );
  
  // In dev mode, return OTP for testing
  const result: any = { challengeId: challenge.challengeId, channel: challenge.channel };
  if (process.env.NODE_ENV === 'development' || process.env.FORCE_DEV_MODE === 'true') {
    result.otp = challenge.otp;
  }
  
  return result;
}

/**
 * Complete registration after OTP verification
 */
export async function completeRegistration(challengeId: string, otp: string) {
  const redisClient = getRedisClient();
  
  const regData = await redisClient.get(`register:${challengeId}`);
  if (!regData) throw new Error('REGISTRATION_EXPIRED');
  
  const { displayName, handle, deviceInfo } = JSON.parse(regData);
  
  // Verify OTP. The challenge may already have been consumed by an earlier
  // /phone/verify call in the same sign-up flow, so accept a VERIFIED status
  // here - the caller still has to present the correct OTP.
  const verifyResult = await verifyOtp(challengeId, otp, { allowAlreadyVerified: true });
  if (!verifyResult.ok) {
    throw new Error(verifyResult.reason || 'OTP_VERIFICATION_FAILED');
  }
  
  // Get challenge to access phone number and metadata
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
  if (!challenge) throw new Error('INVALID_CHALLENGE');
  
  // Get phone number from challenge metadata (for registration) or from phone binding
  let phoneE164: string;
  if (challenge.metadata && typeof challenge.metadata === 'object' && 'phoneE164' in challenge.metadata) {
    phoneE164 = (challenge.metadata as any).phoneE164;
  } else if (challenge.phoneBindingId) {
    const phoneBinding = await prisma.phoneBinding.findUnique({ where: { id: challenge.phoneBindingId } });
    if (!phoneBinding) throw new Error('PHONE_BINDING_NOT_FOUND');
    phoneE164 = (await import('../lib/crypto')).decryptPii(phoneBinding.e164Encrypted);
  } else {
    throw new Error('INVALID_CHALLENGE');
  }
  
  // Normalize + look up the carrier before opening the transaction: both can
  // take real time (network in production) and must not hold a DB connection.
  const parsed = await (await import('./phone')).normalizePhone(phoneE164);
  if (!parsed) throw new Error('INVALID_PHONE_NUMBER');
  
  const carrierInfo = await (await import('./phone')).carrierLookup(phoneE164);
  const e164Hash = require('../lib/crypto').createBlindIndex(phoneE164);
  const e164Encrypted = (await import('../lib/crypto')).encryptPii(phoneE164);
  
  // Account, binding, recovery codes and challenge revocation commit together.
  // Rolling back (taken handle, duplicate number) leaves the OTP untouched so
  // the user can retry - and a commit can never yield a live account that has
  // no recovery codes, which previously happened if code generation failed
  // after the account was already written and the OTP already burned.
  const result = await prisma.$transaction(async (tx) => {
    // Create account first
    const account = await tx.account.create({
      data: {
        handle: handle?.toLowerCase().replace(/[^a-z0-9_]/g, '') || undefined,
        displayName,
        status: 'ACTIVE',
      },
    });
    
    const phoneBinding = await tx.phoneBinding.create({
      data: {
        accountId: account.id,
        e164Hash,
        e164Encrypted,
        country: parsed.country,
        carrier: carrierInfo.name,
        lineType: parsed.lineType,
        portStatus: carrierInfo.isPorted ? 'ported' : 'none',
        status: 'ACTIVE',
        roleFlags: ['LOGIN', 'RECOVERY', 'NOTIFICATIONS'] as any,
        isPrimary: true,
        carrierSnapshot: carrierInfo as any,
      },
    });
    
    const recoveryCodes = await generateRecoveryCodes(account.id, tx);
    
    // Consume the challenge now that the account exists, so the same OTP
    // cannot be replayed to mint a second account for this number.
    await tx.otpChallenge.update({
      where: { id: challengeId },
      data: { status: 'REVOKED' },
    });
    
    return { account, phoneBinding, recoveryCodes };
  });
  
  const { account, phoneBinding, recoveryCodes } = result;
  
  // Register device if provided. Device is optional during sign-up, so a
  // deviceInfo blob without a deviceKey is skipped rather than failing the
  // whole registration - /auth/device/register enforces the requirement.
  let device: any = null;
  if (deviceInfo?.deviceKey) {
    device = await registerDevice(account.id, deviceInfo);
  } else if (deviceInfo) {
    console.warn('[Auth] Skipping device registration: deviceKey missing');
  }
  
  // Create initial session
  const tokens = await createSession(account.id, device?.id, {
    ipAddress: challenge.ipAddress ?? undefined,
    userAgent: challenge.deviceFingerprint ?? undefined,
  });
  
  // Clean up registration intent
  await redisClient.del(`register:${challengeId}`);
  
  // Audit log
  await auditLog({
    accountId: account.id,
    eventType: 'REGISTRATION',
    severity: 'INFO',
    description: `New account registered with phone ${phoneBinding.country}`,
    ipAddress: challenge.ipAddress ?? undefined,
    deviceId: device?.id,
  });
  
  return {
    account: { id: account.id, handle: account.handle, displayName: account.displayName },
    tokens,
    recoveryCodes, // Only returned once!
    device,
  };
}

/**
 * Login with phone number (initiate OTP)
 */
export async function initiateLogin(
  phoneE164: string,
  options: {
    deviceInfo?: DeviceInfo;
    preferredChannel?: 'SMS' | 'VOICE';
    ipAddress?: string;
  } = {}
) {
  const { deviceInfo, preferredChannel = 'SMS', ipAddress } = options;
  
  // Unified "Continue with phone number" - no account enumeration
  const challenge = await createChallenge(phoneE164, preferredChannel, {
    purpose: 'LOGIN',
    deviceId: deviceInfo?.deviceId,
    deviceFingerprint: deviceInfo?.deviceId,
    ipAddress,
  });
  
  return { challengeId: challenge.challengeId, channel: challenge.channel };
}

/**
 * Complete login after OTP verification
 */
export async function completeLogin(challengeId: string, otp: string, deviceInfo?: DeviceInfo, preVerified?: VerifyOtpResult) {
  // The /phone/verify route has usually already consumed the OTP in this same
  // request. Reusing that result keeps the challenge genuinely single-use
  // instead of letting the same code verify twice.
  const verifyResult = preVerified ?? await verifyOtp(challengeId, otp);
  if (!verifyResult.ok) {
    // Check if step-up required
    if (verifyResult.requiresStepUp) {
      return { requiresStepUp: true, stepUpMethods: verifyResult.stepUpMethods };
    }
    throw new Error(verifyResult.reason || 'OTP_VERIFICATION_FAILED');
  }
  
  if (!verifyResult.accountId) throw new Error('NO_ACCOUNT_LINKED');
  
  const account = await prisma.account.findUnique({ where: { id: verifyResult.accountId } });
  if (!account || account.status !== 'ACTIVE') throw new Error('ACCOUNT_INACTIVE');
  
  // Check dormancy policy
  if (account.lastActiveAt && Date.now() - account.lastActiveAt.getTime() > 6 * 30 * 24 * 60 * 60 * 1000) {
    // 6 months dormant - restricted session
    const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
    await auditLog({
      accountId: account.id,
      eventType: 'LOGIN_SUCCESS',
      severity: 'WARNING',
      description: 'Login from dormant account - restricted session',
      ipAddress: challenge?.ipAddress ?? undefined,
    });
  }
  
  // Register/update device. Device is optional, so a deviceInfo blob without
  // a deviceKey falls through to the trusted-device lookup below.
  let device = null;
  if (deviceInfo?.deviceKey) {
    device = await registerDevice(account.id, deviceInfo);
  } else {
    if (deviceInfo) console.warn('[Auth] Skipping device registration: deviceKey missing');
    // Find existing trusted device
    device = await prisma.device.findFirst({
      where: { accountId: account.id, isTrusted: true },
      orderBy: { lastSeenAt: 'desc' },
    });
  }
  
  // Create session
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
  const tokens = await createSession(account.id, device?.id, {
    ipAddress: challenge?.ipAddress ?? undefined,
    userAgent: deviceInfo?.deviceId ?? undefined,
  });
  
  // Update last active
  await prisma.account.update({
    where: { id: account.id },
    data: { lastActiveAt: new Date() },
  });
  
  // Update phone binding last verified
  if (verifyResult.phoneBindingId) {
    await prisma.phoneBinding.update({
      where: { id: verifyResult.phoneBindingId },
      data: { lastVerifiedAt: new Date() },
    });
  }
  
  // Audit log
  await auditLog({
    accountId: account.id,
    eventType: 'LOGIN_SUCCESS',
    severity: 'INFO',
    description: 'Login successful via OTP',
    ipAddress: challenge?.ipAddress ?? undefined,
    deviceId: device?.id,
  });
  
  // Check if passkey enrollment should be prompted
  const hasPasskey = await prisma.credential.count({
    where: { accountId: account.id, type: 'PASSKEY' },
  }) > 0;
  
  return {
    account: { id: account.id, handle: account.handle, displayName: account.displayName },
    tokens,
    device,
    shouldEnrollPasskey: !hasPasskey && device?.isTrusted,
  };
}

/**
 * Create JWT token pair and store session
 */
async function createSession(
  accountId: string,
  deviceId: string | null | undefined,
  context: { ipAddress?: string; userAgent?: string }
): Promise<TokenPair> {
  const device = deviceId ? await prisma.device.findUnique({ where: { id: deviceId } }) : null;
  
  const accessToken = jwt.sign(
    { sub: accountId, deviceId, type: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
  
  const refreshToken = generateSecureToken(32);
  const refreshTokenHash = hashOtp(refreshToken, REFRESH_TOKEN_SALT, JWT_SECRET); // Must match refreshTokens()
  
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  
  await prisma.session.create({
    data: {
      accountId,
      deviceId: deviceId || null,
      accessTokenHash: require('crypto').createHash('sha256').update(accessToken).digest('hex'),
      refreshTokenHash,
      expiresAt,
      refreshExpiresAt,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    },
  });
  
  return {
    accessToken,
    refreshToken,
    expiresIn: 15 * 60,
    tokenType: 'Bearer',
  };
}

/**
 * Refresh access token using refresh token
 */
export async function refreshTokens(refreshToken: string, deviceId?: string) {
  const refreshTokenHash = hashOtp(refreshToken, REFRESH_TOKEN_SALT, JWT_SECRET);
  
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash },
    include: { account: true, device: true },
  });
  
  if (!session || session.revokedAt) throw new Error('INVALID_REFRESH_TOKEN');
  if (session.refreshExpiresAt < new Date()) throw new Error('REFRESH_TOKEN_EXPIRED');
  if (session.account.status !== 'ACTIVE') throw new Error('ACCOUNT_INACTIVE');
  
  const newAccessToken = jwt.sign(
    { sub: session.accountId, deviceId: session.deviceId, type: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
  const newExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const newAccessTokenHash = require('crypto').createHash('sha256').update(newAccessToken).digest('hex');
  
  // Rotate the refresh token once the session is a week old.
  const shouldRotate = session.createdAt < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  if (shouldRotate) {
    // Rotation moves the session to a new row. A new row is mandatory here:
    // refreshTokenHash is @unique, so the old row cannot keep it and we must
    // not overwrite it before revoking, or the rotation lands us on a session
    // whose refresh token no longer verifies.
    const newRefreshToken = generateSecureToken(32);
    const newRefreshTokenHash = hashOtp(newRefreshToken, REFRESH_TOKEN_SALT, JWT_SECRET);
    
    await prisma.session.create({
      data: {
        accountId: session.accountId,
        deviceId: session.deviceId,
        accessTokenHash: newAccessTokenHash,
        refreshTokenHash: newRefreshTokenHash,
        expiresAt: newExpiresAt,
        refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ipAddress: session.ipAddress ?? undefined,
        userAgent: session.userAgent ?? undefined,
      },
    });
    
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: 'ROTATED' },
    });
    
    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: 15 * 60,
      tokenType: 'Bearer',
    };
  }
  
  // No rotation: swap the access token in place on the same row. This used to
  // revoke the row and insert a replacement carrying the SAME refreshTokenHash,
  // which violated the unique constraint - leaving the caller with a revoked
  // session and no working token, i.e. refresh destroyed the session it was
  // supposed to extend.
  await prisma.session.update({
    where: { id: session.id },
    data: {
      accessTokenHash: newAccessTokenHash,
      expiresAt: newExpiresAt,
      lastUsedAt: new Date(),
    },
  });
  
  return {
    accessToken: newAccessToken,
    refreshToken: refreshToken,
    expiresIn: 15 * 60,
    tokenType: 'Bearer',
  };
}

/**
 * Verify access token and return account
 */
export async function verifyAccessToken(accessToken: string) {
  try {
    const decoded = jwt.verify(accessToken, JWT_SECRET) as any;
    if (decoded.type !== 'access') throw new Error('INVALID_TOKEN_TYPE');
    
    const session = await prisma.session.findFirst({
      where: {
        accountId: decoded.sub,
        deviceId: decoded.deviceId,
        accessTokenHash: require('crypto').createHash('sha256').update(accessToken).digest('hex'),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { account: true },
    });
    
    if (!session) throw new Error('SESSION_NOT_FOUND');
    if (session.account.status !== 'ACTIVE') throw new Error('ACCOUNT_INACTIVE');
    
    // Update last used
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });
    
    return { account: session.account, deviceId: session.deviceId };
  } catch (error) {
    throw new Error('INVALID_ACCESS_TOKEN');
  }
}

/**
 * Register device with public key
 */
export async function registerDevice(accountId: string, deviceInfo: DeviceInfo) {
  if (!deviceInfo?.deviceKey) {
    throw new Error('DEVICE_KEY_REQUIRED');
  }
  
  const deviceKeyHash = require('crypto').createHash('sha256').update(deviceInfo.deviceKey).digest('hex');
  
  // Check if device already registered
  let device = await prisma.device.findUnique({ where: { deviceKeyHash } });
  
  if (device) {
    if (device.accountId !== accountId) {
      throw new Error('DEVICE_BOUND_TO_ANOTHER_ACCOUNT');
    }
    // Update existing device
    device = await prisma.device.update({
      where: { id: device.id },
      data: {
        name: deviceInfo.name || device.name,
        platform: deviceInfo.platform || device.platform,
        platformVersion: deviceInfo.platformVersion || device.platformVersion,
        appVersion: deviceInfo.appVersion || device.appVersion,
        attestationType: deviceInfo.attestationType || device.attestationType,
        attestationData: deviceInfo.attestationData || device.attestationData,
        lastSeenAt: new Date(),
        isTrusted: device.isTrusted, // Keep existing trust level
      },
    });
  } else {
    device = await prisma.device.create({
      data: {
        accountId,
        deviceKey: deviceInfo.deviceKey,
        deviceKeyHash,
        name: deviceInfo.name,
        platform: deviceInfo.platform,
        platformVersion: deviceInfo.platformVersion,
        appVersion: deviceInfo.appVersion,
        attestationType: deviceInfo.attestationType,
        attestationData: deviceInfo.attestationData,
        isTrusted: false, // Requires explicit trust
        trustLevel: 'UNVERIFIED',
        lastSeenAt: new Date(),
      },
    });
  }
  
  return device;
}

/**
 * Trust a device (after passkey enrollment or explicit approval)
 */
export async function trustDevice(accountId: string, deviceId: string, trustLevel: 'VERIFIED' | 'TRUSTED' | 'HIGH_TRUST' = 'TRUSTED') {
  const device = await prisma.device.findFirst({ where: { id: deviceId, accountId } });
  if (!device) throw new Error('DEVICE_NOT_FOUND');
  
  const newTrustLevel = trustLevel;
  const newIsTrusted = true; // trustLevel is never 'UNVERIFIED' per function signature
  
  return prisma.device.update({
    where: { id: deviceId },
    data: {
      isTrusted: newIsTrusted,
      trustLevel: newTrustLevel,
    },
  });
}

/**
 * Revoke device (logout from device)
 */
export async function revokeDevice(accountId: string, deviceId: string, revokeAllSessions = true) {
  const device = await prisma.device.findFirst({ where: { id: deviceId, accountId } });
  if (!device) throw new Error('DEVICE_NOT_FOUND');
  
  if (revokeAllSessions) {
    await prisma.session.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'DEVICE_REVOKED' },
    });
  }
  
  return prisma.device.update({
    where: { id: deviceId },
    data: { revokedAt: new Date(), isTrusted: false, trustLevel: 'UNVERIFIED' },
  });
}

/**
 * Generate recovery codes (8-10 single-use codes)
 */
export async function generateRecoveryCodes(accountId: string, tx?: any): Promise<string[]> {
  // Passing a transaction client lets registration mint the codes in the same
  // unit of work as the account row, so neither can exist without the other.
  const db = tx ?? prisma;
  const batchId = require('crypto').randomUUID();
  const codes: string[] = [];
  
  for (let i = 0; i < 10; i++) {
    const code = generateSecureToken(4).toUpperCase(); // 8 hex chars
    const codeHash = hashOtp(code, batchId, JWT_SECRET);
    
    await db.recoveryCode.create({
      data: { accountId, codeHash, batchId },
    });
    
    codes.push(code);
  }
  
  await db.auditLog.create({
    data: {
      accountId,
      eventType: 'RECOVERY_CODE_GENERATED',
      severity: 'INFO',
      description: 'Recovery codes generated',
      metadata: { batchId, count: 10 },
    },
  });
  
  return codes;
}

/**
 * Verify and consume recovery code
 */
export async function verifyRecoveryCode(accountId: string, code: string): Promise<boolean> {
  const codes = await prisma.recoveryCode.findMany({
    where: { accountId, usedAt: null },
  });
  
  for (const rc of codes) {
    // We need to check each hash - in production, use a more efficient approach
    // For now, we'll store a lookup index
    const testHash = hashOtp(code, rc.batchId, JWT_SECRET);
    if (require('../lib/crypto').timingSafeEqual(testHash, rc.codeHash)) {
      await prisma.recoveryCode.update({
        where: { id: rc.id },
        data: { usedAt: new Date() },
      });
      
      await auditLog({
        accountId,
        eventType: 'RECOVERY_CODE_USED',
        severity: 'WARNING',
        description: 'Recovery code used for authentication',
      });
      
      return true;
    }
  }
  
  return false;
}

/**
 * Change phone number
 */
export async function changePhoneNumber(
  accountId: string,
  oldPhoneBindingId: string,
  newPhoneE164: string,
  otp: string,
  deviceId?: string
) {
  // Verify old number (proof of possession)
  const oldBinding = await prisma.phoneBinding.findFirst({
    where: { id: oldPhoneBindingId, accountId },
  });
  if (!oldBinding) throw new Error('OLD_NUMBER_NOT_FOUND');
  
  // Verify OTP on new number
  const challenge = await createChallenge(newPhoneE164, 'SMS', {
    purpose: 'NUMBER_CHANGE',
    deviceId,
  });
  
  // Wait for OTP verification (in real flow, this would be async)
  // For now, we'll simulate by storing pending change
  const redisClient = getRedisClient();
  await redisClient.setex(
    `number_change:${accountId}`,
    300,
    JSON.stringify({ oldBindingId: oldPhoneBindingId, newPhoneE164, challengeId: challenge.challengeId })
  );
  
  return { challengeId: challenge.challengeId };
}

/**
 * Complete phone number change
 */
export async function completePhoneNumberChange(accountId: string, otp: string) {
  const redisClient = getRedisClient();
  
  const changeData = await redisClient.get(`number_change:${accountId}`);
  if (!changeData) throw new Error('NO_PENDING_NUMBER_CHANGE');
  
  const { oldBindingId, newPhoneE164, challengeId } = JSON.parse(changeData);
  
  // Verify OTP
  const verifyResult = await verifyOtp(challengeId, otp);
  if (!verifyResult.ok) throw new Error(verifyResult.reason || 'OTP_VERIFICATION_FAILED');
  
  // Carrier lookup for new number
  const carrierInfo = await (await import('./phone')).carrierLookup(newPhoneE164);
  const parsed = await (await import('./phone')).normalizePhone(newPhoneE164);
  
  // Create new binding
  const newBinding = await createPhoneBinding(accountId, parsed!, carrierInfo, ['LOGIN', 'RECOVERY', 'NOTIFICATIONS'], true);
  await verifyPhoneBinding(newBinding.id, carrierInfo);
  
  // Release old binding
  await prisma.phoneBinding.update({
    where: { id: oldBindingId },
    data: { status: 'RELEASED', roleFlags: [] },
  });
  
  // Revoke all sessions (security)
  await prisma.session.updateMany({
    where: { accountId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'NUMBER_CHANGED' },
  });
  
  // Lock high-risk actions for 48-72 hours
  await setSecurityCooldown(accountId, 'NUMBER_CHANGE', 72);
  
  // Alert all verified numbers and devices
  await alertAllChannels(accountId, 'SECURITY_ALERT', 'Your phone number has been changed. If this wasn\'t you, contact support immediately.');
  
  await redisClient.del(`number_change:${accountId}`);
  
  await auditLog({
    accountId,
    eventType: 'NUMBER_CHANGED',
    severity: 'WARNING',
    description: 'Phone number changed',
    metadata: { oldBindingId, newBindingId: newBinding.id },
  });
  
  return { success: true, newBinding };
}

/**
 * Set security cooldown on sensitive actions
 */
export async function setSecurityCooldown(accountId: string, reason: string, hours: number) {
  await prisma.account.update({
    where: { id: accountId },
    data: { metadata: { cooldownUntil: new Date(Date.now() + hours * 60 * 60 * 1000), cooldownReason: reason } },
  });
}

/**
 * Check if account has active security cooldown
 */
export async function checkSecurityCooldown(accountId: string): Promise<{ active: boolean; reason?: string; until?: Date }> {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { metadata: true } });
  if (!account?.metadata) return { active: false };
  
  const meta = account.metadata as any;
  if (meta.cooldownUntil && new Date(meta.cooldownUntil) > new Date()) {
    return { active: true, reason: meta.cooldownReason, until: new Date(meta.cooldownUntil) };
  }
  return { active: false };
}

/**
 * Alert all verified channels
 */
async function alertAllChannels(accountId: string, type: string, message: string) {
  const bindings = await prisma.phoneBinding.findMany({
    where: { accountId, status: 'ACTIVE', roleFlags: { has: 'NOTIFICATIONS' } },
  });
  
  for (const binding of bindings) {
    const phone = getDecryptedPhone(binding);
    // Send via SMS, push, in-app
    await prisma.inboxMessage.create({
      data: { accountId, type: 'SECURITY_ALERT', category: 'SECURITY', subject: 'Security Alert', body: message, priority: 'HIGH' },
    });
  }
  
  // Also push to devices
  const devices = await prisma.device.findMany({ where: { accountId, isTrusted: true } });
  for (const device of devices) {
    await sendPush(accountId, { title: 'Security Alert', body: message, deepLink: '/security' });
  }
}

/**
 * Audit logging helper
 */
export async function auditLog(entry: {
  accountId?: string;
  eventType: any;
  severity: any;
  description: string;
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  metadata?: any;
}) {
  await prisma.auditLog.create({
    data: {
      accountId: entry.accountId,
      eventType: entry.eventType,
      severity: entry.severity,
      description: entry.description,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      deviceId: entry.deviceId,
      metadata: entry.metadata,
    },
  });
}

/**
 * Logout (revoke session)
 */
export async function logout(accessToken: string) {
  const accessTokenHash = require('crypto').createHash('sha256').update(accessToken).digest('hex');
  
  await prisma.session.updateMany({
    where: { accessTokenHash, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
  });
}

/**
 * Revoke all sessions for account
 */
export async function revokeAllSessions(accountId: string, reason = 'SECURITY') {
  await prisma.session.updateMany({
    where: { accountId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}