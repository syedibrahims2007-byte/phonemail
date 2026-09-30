import { Router } from 'express';
import { normalizePhone } from '../services/phone';
import { initiateLogin, completeLogin, initiateRegistration, completeRegistration, registerDevice, trustDevice, revokeDevice, refreshTokens, verifyAccessToken, logout, revokeAllSessions, verifyRecoveryCode } from '../services/auth';
import { createChallenge, verifyOtp } from '../services/otp';
import { prisma } from '../lib/prisma';
import { generateRecoveryCodes } from '../services/auth';

const router = Router();

// Shared lazy Redis connection. Creating a client per request leaked sockets
// because nothing ever closed them.
let _redis: any = null;
function getRedis() {
  if (!_redis) {
    const Redis = require('ioredis').default;
    _redis = new Redis(process.env.REDIS_URL!);
    _redis.on('error', (err: Error) => console.error('[Redis] error:', err.message));
  }
  return _redis;
}

// Known service errors -> HTTP status + payload. Anything unmatched stays a
// 500 so genuine bugs still surface loudly instead of masquerading as 4xx.
const AUTH_ERRORS: Record<string, { status: number; error: string }> = {
  EXPIRED_OR_INVALID: { status: 400, error: 'EXPIRED_OR_INVALID' },
  MISMATCH: { status: 400, error: 'MISMATCH' },
  MAX_ATTEMPTS: { status: 429, error: 'MAX_ATTEMPTS' },
  REGISTRATION_EXPIRED: { status: 410, error: 'REGISTRATION_EXPIRED' },
  NUMBER_ALREADY_REGISTERED: { status: 409, error: 'NUMBER_ALREADY_REGISTERED' },
  NO_ACCOUNT_LINKED: { status: 400, error: 'NO_ACCOUNT_LINKED' },
  ACCOUNT_INACTIVE: { status: 403, error: 'ACCOUNT_INACTIVE' },
  INVALID_PHONE_NUMBER: { status: 400, error: 'INVALID_PHONE_NUMBER' },
  DEVICE_KEY_REQUIRED: { status: 400, error: 'DEVICE_KEY_REQUIRED' },
  DEVICE_BOUND_TO_ANOTHER_ACCOUNT: { status: 409, error: 'DEVICE_BOUND_TO_ANOTHER_ACCOUNT' },
  SIM_SWAP_REQUIRES_STEPUP: { status: 403, error: 'STEP_UP_REQUIRED' },
  RATE_LIMITED: { status: 429, error: 'RATE_LIMITED' },
};

function sendAuthError(res: any, error: any) {
  const mapped = AUTH_ERRORS[error?.message];
  if (mapped) {
    return res.status(mapped.status).json({ error: mapped.error });
  }
  
  // Prisma unique-constraint violation (duplicate handle / phone number)
  if (error?.code === 'P2002') {
    const target = Array.isArray(error?.meta?.target) ? error.meta.target.join(', ') : error?.meta?.target;
    console.warn(`Unique constraint violated on: ${target}`);
    return res.status(409).json({ error: 'ALREADY_EXISTS', target });
  }
  
  console.error('Unhandled auth error:', error);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}

// Middleware to verify access token
export const authMiddleware = async (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' });
  }
  
  const accessToken = authHeader.substring(7);
  try {
    const { account, deviceId } = await verifyAccessToken(accessToken);
    req.account = account;
    req.deviceId = deviceId;
    req.accessToken = accessToken;
    next();
  } catch (error: any) {
    return res.status(401).json({ error: 'INVALID_TOKEN', message: error.message });
  }
};

// ============================================================
// AUTHENTICATION ENDPOINTS
// ============================================================

// Unified "Continue with phone number" - initiates login or registration
router.post('/phone/start', async (req, res) => {
  try {
    const { phone, channel = 'SMS', deviceId, deviceFingerprint, ipAddress } = req.body;
    
    console.log('Auth start request:', { phone, channel, deviceId });
    
    if (!phone) return res.status(400).json({ error: 'PHONE_REQUIRED' });
    
    const parsed = normalizePhone(phone);
    console.log('Parsed phone:', parsed);
    if (!parsed) return res.status(400).json({ error: 'INVALID_PHONE_NUMBER' });
    
    // Check if number exists (but don't reveal - unified response)
    const e164Hash = require('../lib/crypto').createBlindIndex(parsed.e164);
    const binding = await prisma.phoneBinding.findUnique({ where: { e164Hash } });
    console.log('Binding:', binding);
    
    const challenge = await createChallenge(parsed.e164, channel, {
      deviceId,
      deviceFingerprint,
      ipAddress: ipAddress || req.ip,
      countryPrefix: parsed.e164.substring(0, 3),
      purpose: binding ? 'LOGIN' : 'REGISTER',
    });
    console.log('Challenge created:', challenge.challengeId);
    
    // Store OTP for voice fallback if needed
    if (channel === 'VOICE') {
      await require('../services/voice').storeOtpForVoice(challenge.challengeId, challenge.otp);
    }
    
    const payload: any = { 
      challengeId: challenge.challengeId, 
      channel: challenge.channel,
      expiresIn: 300,
    };
    // Dev mode only, mirroring initiateRegistration: nothing is texted, so the
    // UI can surface the code instead of making you tail server.log. This key
    // is never present when Twilio actually delivers.
    if (process.env.NODE_ENV === 'development' || process.env.FORCE_DEV_MODE === 'true') {
      payload.otp = challenge.otp;
    }
    
    res.json(payload);
  } catch (error: any) {
    console.error('Auth start error:', error);
    console.error('Stack:', error.stack);
    if (error.message === 'RATE_LIMITED') {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests. Please wait.' });
    }
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error.message || 'Unknown error' });
  }
});

// Verify OTP and complete login/registration
router.post('/phone/verify', async (req, res) => {
  try {
    const { challengeId, otp, deviceInfo, stepUp } = req.body;
    
    if (!challengeId || !otp) return res.status(400).json({ error: 'MISSING_PARAMS' });
    
    const result = await verifyOtp(challengeId, otp, {
      stepUpProof: stepUp?.method ? { method: stepUp.method, code: stepUp.code } : undefined,
    });
    
    if (!result.ok) {
      if (result.requiresStepUp) {
        return res.status(403).json({ 
          error: 'STEP_UP_REQUIRED', 
          message: 'Additional verification required due to security concerns',
          methods: result.stepUpMethods,
        });
      }
      return res.status(400).json({ 
        error: result.reason, 
        attemptsLeft: result.attemptsLeft 
      });
    }
    
    if (result.accountId) {
      // Existing account - complete login. Reuse the verification we just
      // performed so the OTP is only ever checked once.
      const loginResult = await completeLogin(challengeId, otp, deviceInfo, result);
      return res.json(loginResult);
    } else {
      // New account - complete registration
      // Registration data was stored during challenge creation
      const regData = await getRedis().get(`register:${challengeId}`);
      
      if (regData) {
        const regResult = await completeRegistration(challengeId, otp);
        return res.status(201).json(regResult);
      } else {
        // No registration data - just verified phone, need to complete registration
        return res.json({ 
          verified: true, 
          phoneBindingId: result.phoneBindingId,
          needsRegistration: true 
        });
      }
    }
  } catch (error: any) {
    console.error('Auth verify error:', error);
    sendAuthError(res, error);
  }
});

// Register device for passkey/device-bound auth
router.post('/device/register', authMiddleware, async (req: any, res) => {
  try {
    const { deviceKey, name, platform, platformVersion, appVersion, attestationType, attestationData } = req.body;
    
    if (!deviceKey) return res.status(400).json({ error: 'DEVICE_KEY_REQUIRED' });
    
    const device = await registerDevice(req.account.id, {
      deviceId: require('crypto').randomUUID(),
      deviceKey,
      name,
      platform,
      platformVersion,
      appVersion,
      attestationType,
      attestationData,
    });
    
    res.json({ device });
  } catch (error: any) {
    if (error.message === 'DEVICE_BOUND_TO_ANOTHER_ACCOUNT') {
      return res.status(409).json({ error: 'DEVICE_CONFLICT' });
    }
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Trust device (after passkey enrollment)
router.post('/device/trust', authMiddleware, async (req: any, res) => {
  try {
    const { deviceId, trustLevel } = req.body;
    
    const device = await trustDevice(req.account.id, deviceId, trustLevel);
    res.json({ device });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Revoke device
router.delete('/device/:deviceId', authMiddleware, async (req: any, res) => {
  try {
    await revokeDevice(req.account.id, req.params.deviceId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Refresh tokens
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'REFRESH_TOKEN_REQUIRED' });
    
    const tokens = await refreshTokens(refreshToken);
    res.json(tokens);
  } catch (error: any) {
    res.status(401).json({ error: error.message });
  }
});

// Logout
router.post('/logout', authMiddleware, async (req: any, res) => {
  try {
    await logout(req.accessToken);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Revoke all sessions
router.post('/revoke-all', authMiddleware, async (req: any, res) => {
  try {
    await revokeAllSessions(req.account.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Get current account info
router.get('/me', authMiddleware, async (req: any, res) => {
  try {
    const [account, recoveryCodesRemaining] = await Promise.all([
      prisma.account.findUnique({
        where: { id: req.account.id },
        select: {
          id: true,
          handle: true,
          displayName: true,
          status: true,
          createdAt: true,
          lastActiveAt: true,
          phoneBindings: {
            where: { status: 'ACTIVE' },
            select: { id: true, country: true, lineType: true, isPrimary: true, roleFlags: true, verifiedAt: true, lastVerifiedAt: true },
          },
          devices: {
            where: { revokedAt: null },
            select: { id: true, name: true, platform: true, isTrusted: true, trustLevel: true, lastSeenAt: true },
          },
        },
      }),
      // Surfaced so the UI can warn before the account is left with no
      // second factor at all (used codes can never be reused).
      prisma.recoveryCode.count({ where: { accountId: req.account.id, usedAt: null } }),
    ]);
    
    res.json({ account, recoveryCodesRemaining });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ============================================================
// REGISTRATION ENDPOINTS
// ============================================================

// Complete registration after phone verification
router.post('/register/complete', async (req, res) => {
  try {
    const { challengeId, otp, displayName, handle, deviceInfo } = req.body;
    
    if (!challengeId || !otp) return res.status(400).json({ error: 'MISSING_PARAMS' });
    
    const redisClient = getRedis();
    
    const regData = {
      displayName,
      handle: handle?.toLowerCase().replace(/[^a-z0-9_]/g, ''),
      deviceInfo,
    };
    
    await redisClient.setex(`register:${challengeId}`, 300, JSON.stringify(regData));
    
    const result = await completeRegistration(challengeId, otp);
    res.status(201).json(result);
  } catch (error: any) {
    console.error('Registration error:', error);
    sendAuthError(res, error);
  }
});

// Generate recovery codes
router.post('/recovery-codes', authMiddleware, async (req: any, res) => {
  try {
    const codes = await generateRecoveryCodes(req.account.id);
    res.json({ codes }); // Only returned once!
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Verify recovery code
router.post('/recovery-code/verify', async (req, res) => {
  try {
    const { accountId, code } = req.body;
    if (!accountId || !code) return res.status(400).json({ error: 'MISSING_PARAMS' });
    
    const valid = await verifyRecoveryCode(accountId, code);
    res.json({ valid });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;