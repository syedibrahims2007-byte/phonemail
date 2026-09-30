// src/routes/phones.routes.ts
import { Router } from 'express';
import { authMiddleware } from './auth.routes';
import { prisma } from '../lib/prisma';
import { normalizePhone, getDecryptedPhone, getMaskedPhone, createPhoneBinding, verifyPhoneBinding, canAddPhoneBinding } from '../services/phone';
import { createChallenge } from '../services/otp';
import { auditLog } from '../services/auth';
import { createInboxMessage } from '../services/inbox';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// ============================================================
// PHONE NUMBER MANAGEMENT
// ============================================================

// Helper to convert role flags array to bitmask for backwards compatibility
function roleFlagsToBitmask(flags: string[]): number {
  let mask = 0;
  if (flags.includes('LOGIN')) mask |= 1;
  if (flags.includes('RECOVERY')) mask |= 2;
  if (flags.includes('NOTIFICATIONS')) mask |= 4;
  return mask;
}

function bitmaskToRoleFlags(mask: number): string[] {
  const flags: string[] = [];
  if (mask & 1) flags.push('LOGIN');
  if (mask & 2) flags.push('RECOVERY');
  if (mask & 4) flags.push('NOTIFICATIONS');
  return flags;
}

// List verified phone numbers
router.get('/', async (req: any, res) => {
  try {
    const bindings = await prisma.phoneBinding.findMany({
      where: { accountId: req.account.id, status: { in: ['ACTIVE', 'PENDING'] } },
      select: {
        id: true,
        country: true,
        lineType: true,
        status: true,
        roleFlags: true,
        isPrimary: true,
        verifiedAt: true,
        lastVerifiedAt: true,
        carrier: true,
        portStatus: true,
        createdAt: true,
        e164Encrypted: true,
      },
    });
    
    const phones = bindings.map(b => ({
      ...b,
      roleFlags: bitmaskToRoleFlags(roleFlagsToBitmask(b.roleFlags as string[])), // Normalize
      maskedNumber: getMaskedPhone({ e164Encrypted: b.e164Encrypted }),
    }));
    
    res.json({ phones });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Add new phone number
router.post('/', async (req: any, res) => {
  try {
    const { phone, roleFlags = ['LOGIN', 'RECOVERY', 'NOTIFICATIONS'], channel = 'SMS' } = req.body;
    
    if (!phone) return res.status(400).json({ error: 'PHONE_REQUIRED' });
    
    // Check limit
    const canAdd = await canAddPhoneBinding(req.account.id);
    if (!canAdd) return res.status(400).json({ error: 'MAX_PHONES_REACHED' });
    
    const parsed = normalizePhone(phone);
    if (!parsed) return res.status(400).json({ error: 'INVALID_PHONE_NUMBER' });
    
    // Carrier lookup
    const carrierInfo = await (await import('../services/phone')).carrierLookup(parsed.e164);
    
    // Create binding
    const binding = await createPhoneBinding(req.account.id, parsed, carrierInfo, roleFlags, false);
    
    // Send OTP for verification
    const challenge = await createChallenge(parsed.e164, channel, {
      purpose: 'VERIFY_NUMBER',
      deviceId: req.deviceId,
    });
    
    if (channel === 'VOICE') {
      await require('../services/voice').storeOtpForVoice(challenge.challengeId, challenge.otp);
    }
    
    const payload: any = { 
      binding: { id: binding.id, country: binding.country, lineType: binding.lineType, status: binding.status },
      challengeId: challenge.challengeId,
      channel: challenge.channel,
    };
    // Dev mode only - same contract as /auth/phone/start, so the UI can show
    // the code inline instead of sending you to server.log.
    if (process.env.NODE_ENV === 'development' || process.env.FORCE_DEV_MODE === 'true') {
      payload.otp = challenge.otp;
    }
    
    res.status(201).json(payload);
  } catch (error: any) {
    if (error.message === 'NUMBER_ALREADY_BOUND') {
      return res.status(409).json({ error: 'NUMBER_ALREADY_BOUND' });
    }
    if (error.message === 'NUMBER_PENDING_ANOTHER_ACCOUNT') {
      return res.status(409).json({ error: 'NUMBER_PENDING_OTHER' });
    }
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Verify phone number
router.post('/:id/verify', async (req: any, res) => {
  try {
    const { challengeId, otp } = req.body;
    
    const binding = await prisma.phoneBinding.findFirst({
      where: { id: req.params.id, accountId: req.account.id },
    });
    
    if (!binding) return res.status(404).json({ error: 'PHONE_NOT_FOUND' });
    
    const result = await (await import('../services/otp')).verifyOtp(challengeId, otp);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason, attemptsLeft: result.attemptsLeft });
    }
    
    // Verify binding
    await verifyPhoneBinding(binding.id);
    
    await auditLog({
      accountId: req.account.id,
      eventType: 'NUMBER_ADDED',
      severity: 'INFO',
      description: 'New phone number verified and added',
      deviceId: req.deviceId,
      metadata: { bindingId: binding.id, country: binding.country },
    });
    
    res.json({ success: true, binding: { id: binding.id, status: 'ACTIVE' } });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Set primary phone
router.patch('/:id/primary', async (req: any, res) => {
  try {
    const binding = await prisma.phoneBinding.findFirst({
      where: { id: req.params.id, accountId: req.account.id, status: 'ACTIVE' },
    });
    
    if (!binding) return res.status(404).json({ error: 'PHONE_NOT_FOUND' });
    
    // Unset current primary
    await prisma.phoneBinding.updateMany({
      where: { accountId: req.account.id, isPrimary: true },
      data: { isPrimary: false },
    });
    
    // Set new primary
    await prisma.phoneBinding.update({
      where: { id: binding.id },
      data: { isPrimary: true },
    });
    
    await auditLog({
      accountId: req.account.id,
      eventType: 'NUMBER_CHANGED',
      severity: 'WARNING',
      description: 'Primary phone number changed',
      deviceId: req.deviceId,
      metadata: { newPrimaryId: binding.id },
    });
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Update phone role flags
router.patch('/:id/roles', async (req: any, res) => {
  try {
    const { roleFlags } = req.body; // Array of strings: ['LOGIN', 'RECOVERY', 'NOTIFICATIONS']
    
    if (!Array.isArray(roleFlags) || !roleFlags.every(f => ['LOGIN', 'RECOVERY', 'NOTIFICATIONS'].includes(f))) {
      return res.status(400).json({ error: 'INVALID_ROLE_FLAGS' });
    }
    
    // Must keep at least one login-capable number
    if (!roleFlags.includes('LOGIN')) {
      const otherLogin = await prisma.phoneBinding.findFirst({
        where: { accountId: req.account.id, status: 'ACTIVE', roleFlags: { has: 'LOGIN' }, id: { not: req.params.id } },
      });
      if (!otherLogin) return res.status(400).json({ error: 'MUST_HAVE_LOGIN_NUMBER' });
    }
    
    const binding = await prisma.phoneBinding.update({
      where: { id: req.params.id, accountId: req.account.id },
      data: { roleFlags },
    });
    
    await auditLog({
      accountId: req.account.id,
      eventType: 'SETTINGS_CHANGED',
      severity: 'INFO',
      description: 'Phone number roles updated',
      deviceId: req.deviceId,
      metadata: { bindingId: binding.id, roleFlags: binding.roleFlags },
    });
    
    res.json({ success: true, roleFlags: binding.roleFlags });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Remove phone number
router.delete('/:id', async (req: any, res) => {
  try {
    const binding = await prisma.phoneBinding.findFirst({
      where: { id: req.params.id, accountId: req.account.id },
    });
    
    if (!binding) return res.status(404).json({ error: 'PHONE_NOT_FOUND' });
    
    // Can't remove last login-capable number
    if (binding.roleFlags.includes('LOGIN')) {
      const otherLogin = await prisma.phoneBinding.findFirst({
        where: { accountId: req.account.id, status: 'ACTIVE', roleFlags: { has: 'LOGIN' }, id: { not: binding.id } },
      });
      if (!otherLogin) return res.status(400).json({ error: 'MUST_HAVE_LOGIN_NUMBER' });
    }
    
    // If primary, promote another
    if (binding.isPrimary) {
      const other = await prisma.phoneBinding.findFirst({
        where: { accountId: req.account.id, status: 'ACTIVE', id: { not: binding.id } },
      });
      if (other) {
        await prisma.phoneBinding.update({
          where: { id: other.id },
          data: { isPrimary: true },
        });
      }
    }
    
    await prisma.phoneBinding.update({
      where: { id: binding.id },
      data: { status: 'RELEASED', roleFlags: [] },
    });
    
    await auditLog({
      accountId: req.account.id,
      eventType: 'NUMBER_REMOVED',
      severity: 'WARNING',
      description: 'Phone number removed',
      deviceId: req.deviceId,
      metadata: { bindingId: binding.id, country: binding.country },
    });
    
    // Alert other channels
    await createInboxMessage({
      accountId: req.account.id,
      type: 'SECURITY_ALERT',
      category: 'SECURITY',
      subject: 'Phone Number Removed',
      body: `A phone number (${binding.country}) was removed from your account.`,
      priority: 'HIGH',
    });
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Change phone number (requires OTP on both old and new)
router.post('/change', async (req: any, res) => {
  try {
    const { oldPhoneBindingId, newPhone, otp } = req.body;
    
    const result = await require('../services/auth').changePhoneNumber(
      req.account.id,
      oldPhoneBindingId,
      newPhone,
      otp,
      req.deviceId
    );
    
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Request fallback channel for OTP
router.post('/otp/fallback', async (req: any, res) => {
  try {
    const { challengeId, channel } = req.body;
    
    if (!challengeId || !channel) return res.status(400).json({ error: 'MISSING_PARAMS' });
    
    const challenge = await (await import('../services/otp')).getChallengeInfo(challengeId);
    if (!challenge) return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND' });
    
    // Revoke old challenge, create new with different channel
    await prisma.otpChallenge.update({
      where: { id: challengeId },
      data: { status: 'REVOKED' },
    });
    
    const phone = getDecryptedPhone(challenge.phoneBinding!);
    const newChallenge = await createChallenge(phone, channel, {
      purpose: 'LOGIN',
      deviceId: req.deviceId,
    });
    
    if (channel === 'VOICE') {
      await require('../services/voice').storeOtpForVoice(newChallenge.challengeId, newChallenge.otp);
    }
    
    res.json({ challengeId: newChallenge.challengeId, channel: newChallenge.channel });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;