// src/services/recovery.ts
import { prisma } from '../lib/prisma';
import { createChallenge } from './otp';
import { sendPush } from './push';
import { sendSmsNotification } from './sms';
import { createInboxMessage } from './inbox';
import { auditLog } from './auth';
import { notificationQueue } from '../queues/notification.queue';

export interface RecoveryOptions {
  accountId: string;
  tier: 'SAME_NUMBER_OTP' | 'TRUSTED_DEVICE_APPROVAL' | 'RECOVERY_CODE' | 'SECONDARY_NUMBER' | 'TRUSTED_CONTACT' | 'IDENTITY_VERIFICATION';
  trigger: string;
  deviceId?: string;
  ipAddress?: string;
  metadata?: any;
}

/**
 * Initiate account recovery
 */
export async function initiateRecovery(options: RecoveryOptions) {
  const { accountId, tier, trigger, deviceId, ipAddress, metadata } = options;
  
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error('ACCOUNT_NOT_FOUND');
  
  // Check if recovery already in progress
  const existing = await prisma.recoveryAttempt.findFirst({
    where: { accountId, status: { in: ['INITIATED', 'PENDING_APPROVAL', 'WAITING_PERIOD'] } },
  });
  
  if (existing) throw new Error('RECOVERY_ALREADY_IN_PROGRESS');
  
  // Determine waiting period for high-friction tiers
  let waitingUntil: Date | undefined;
  if (['TRUSTED_CONTACT', 'IDENTITY_VERIFICATION'].includes(tier)) {
    waitingUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  }
  
  const attempt = await prisma.recoveryAttempt.create({
    data: {
      accountId,
      tier: tier as any,
      trigger,
      status: 'INITIATED',
      waitingUntil,
      metadata: { deviceId, ipAddress, ...metadata },
    },
  });
  
  // Alert all remaining channels
  await alertAllRecoveryChannels(accountId, attempt.id, tier);
  
  // Execute tier-specific logic
  switch (tier) {
    case 'SAME_NUMBER_OTP':
      await initiateSameNumberOtp(accountId, attempt.id, deviceId, ipAddress);
      break;
      
    case 'TRUSTED_DEVICE_APPROVAL':
      await initiateTrustedDeviceApproval(accountId, attempt.id);
      break;
      
    case 'RECOVERY_CODE':
      // User provides recovery code - handled at verification
      await updateAttemptStatus(attempt.id, 'PENDING_APPROVAL');
      break;
      
    case 'SECONDARY_NUMBER':
      await initiateSecondaryNumberRecovery(accountId, attempt.id);
      break;
      
    case 'TRUSTED_CONTACT':
      await initiateTrustedContactRecovery(accountId, attempt.id);
      break;
      
    case 'IDENTITY_VERIFICATION':
      await initiateIdentityVerification(accountId, attempt.id);
      break;
  }
  
  await auditLog({
    accountId,
    eventType: 'RECOVERY_INITIATED',
    severity: 'WARNING',
    description: `Recovery initiated: ${tier}`,
    ipAddress,
    deviceId,
    metadata: { attemptId: attempt.id, tier, trigger },
  });
  
  return { attemptId: attempt.id, tier, waitingUntil };
}

async function initiateSameNumberOtp(accountId: string, attemptId: string, deviceId?: string, ipAddress?: string) {
  const primaryBinding = await prisma.phoneBinding.findFirst({
    where: { accountId, isPrimary: true, status: 'ACTIVE' },
  });
  
  if (!primaryBinding) throw new Error('NO_PRIMARY_NUMBER');
  
  const phone = require('../lib/crypto').decryptPii(primaryBinding.e164Encrypted);
  
  const challenge = await createChallenge(phone, 'SMS', {
    purpose: 'RECOVERY',
    deviceId,
    ipAddress,
  });
  
  await prisma.recoveryAttempt.update({
    where: { id: attemptId },
    data: { 
      status: 'PENDING_APPROVAL',
      metadata: { challengeId: challenge.challengeId },
    },
  });
  
  // Store OTP for voice fallback
  await require('../services/voice').storeOtpForVoice(challenge.challengeId, challenge.otp);
}

async function initiateTrustedDeviceApproval(accountId: string, attemptId: string) {
  const trustedDevices = await prisma.device.findMany({
    where: { accountId, isTrusted: true, revokedAt: null },
  });
  
  if (!trustedDevices.length) throw new Error('NO_TRUSTED_DEVICES');
  
  // Send push to all trusted devices
  for (const device of trustedDevices) {
    await sendPush(accountId, {
      title: 'Recovery Approval Required',
      body: 'A recovery request was initiated. Approve or deny from this device.',
      deepLink: `/recovery/approve/${attemptId}`,
      priority: 'high',
    });
  }
  
  // Create in-app message
  await createInboxMessage({
    accountId,
    type: 'SECURITY_ALERT',
    category: 'SECURITY',
    subject: 'Recovery Approval Required',
    body: 'A recovery request was initiated. Open the app to approve or deny.',
    priority: 'CRITICAL',
    payload: { attemptId, type: 'TRUSTED_DEVICE_APPROVAL' },
  });
  
  await updateAttemptStatus(attemptId, 'PENDING_APPROVAL');
}

async function initiateSecondaryNumberRecovery(accountId: string, attemptId: string) {
  const secondaryBindings = await prisma.phoneBinding.findMany({
    where: { 
      accountId, 
      status: 'ACTIVE', 
      roleFlags: { has: 'RECOVERY' },
      isPrimary: false,
    },
  });
  
  if (!secondaryBindings.length) throw new Error('NO_SECONDARY_NUMBER');
  
  // For simplicity, use first secondary number
  const binding = secondaryBindings[0];
  const phone = require('../lib/crypto').decryptPii(binding.e164Encrypted);
  
  const challenge = await createChallenge(phone, 'SMS', { purpose: 'RECOVERY' });
  
  await prisma.recoveryAttempt.update({
    where: { id: attemptId },
    data: { 
      status: 'PENDING_APPROVAL',
      metadata: { challengeId: challenge.challengeId, phoneBindingId: binding.id },
    },
  });
}

async function initiateTrustedContactRecovery(accountId: string, attemptId: string) {
  const contacts = await prisma.trustedContact.findMany({
    where: { accountId, confirmedAt: { not: null } },
    take: 3,
  });
  
  if (contacts.length < 2) throw new Error('INSUFFICIENT_TRUSTED_CONTACTS');
  
  // Notify trusted contacts
  for (const contact of contacts) {
    const contactAccount = await prisma.account.findUnique({ where: { id: contact.contactAccountId } });
    if (contactAccount) {
      await createInboxMessage({
        accountId: contact.contactAccountId,
        type: 'SECURITY_ALERT',
        category: 'SECURITY',
        subject: 'Recovery Request for Trusted Contact',
        body: `Your trusted contact needs help recovering their account. Review and respond in the app.`,
        priority: 'HIGH',
        payload: { attemptId, contactAccountId: accountId, type: 'TRUSTED_CONTACT_RECOVERY' },
      });
      
      await sendPush(contact.contactAccountId, {
        title: 'Trusted Contact Recovery Request',
        body: 'A trusted contact needs help recovering their account.',
        deepLink: `/recovery/contact/${attemptId}`,
        priority: 'high',
      });
    }
  }
  
  await updateAttemptStatus(attemptId, 'WAITING_PERIOD');
  
  // Schedule timeout job
  await notificationQueue.add('recovery-timeout', { recoveryAttemptId: attemptId }, { 
    delay: 7 * 24 * 60 * 60 * 1000,
    jobId: `recovery-timeout-${attemptId}`,
  });
}

async function initiateIdentityVerification(accountId: string, attemptId: string) {
  // This would integrate with KYC provider (document + liveness)
  // For now, create in-app message with instructions
  await createInboxMessage({
    accountId,
    type: 'SECURITY_ALERT',
    category: 'SECURITY',
    subject: 'Identity Verification Required',
    body: 'Account recovery requires identity verification. Follow the in-app flow to submit documents.',
    priority: 'CRITICAL',
    payload: { attemptId, type: 'IDENTITY_VERIFICATION', provider: 'internal' },
  });
  
  await updateAttemptStatus(attemptId, 'WAITING_PERIOD');
  
  // Schedule timeout job (5-7 days)
  const timeoutDays = 7;
  await notificationQueue.add('recovery-timeout', { recoveryAttemptId: attemptId }, { 
    delay: timeoutDays * 24 * 60 * 60 * 1000,
    jobId: `recovery-timeout-${attemptId}`,
  });
}

async function updateAttemptStatus(attemptId: string, status: string) {
  await prisma.recoveryAttempt.update({
    where: { id: attemptId },
    data: { status: status as any },
  });
}

/**
 * Approve recovery from trusted device
 */
export async function approveRecovery(attemptId: string, approverDeviceId: string, approved: boolean) {
  const attempt = await prisma.recoveryAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new Error('RECOVERY_ATTEMPT_NOT_FOUND');
  
  if (attempt.status !== 'PENDING_APPROVAL') throw new Error('RECOVERY_NOT_PENDING');
  
  if (!approved) {
    await cancelRecovery(attemptId, approverDeviceId);
    return { success: false, cancelled: true };
  }
  
  // Verify approver device is trusted for this account
  const device = await prisma.device.findFirst({
    where: { id: approverDeviceId, accountId: attempt.accountId, isTrusted: true },
  });
  
  if (!device) throw new Error('UNAUTHORIZED_DEVICE');
  
  // Complete recovery
  await completeRecovery(attemptId, approverDeviceId);
  
  return { success: true };
}

/**
 * Cancel recovery attempt
 */
export async function cancelRecovery(attemptId: string, cancelledBy: string) {
  const attempt = await prisma.recoveryAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new Error('RECOVERY_ATTEMPT_NOT_FOUND');
  
  if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(attempt.status)) {
    throw new Error('RECOVERY_ALREADY_FINISHED');
  }
  
  await prisma.recoveryAttempt.update({
    where: { id: attemptId },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy },
  });
  
  // Alert all channels
  await alertAllRecoveryChannels(attempt.accountId, attemptId, attempt.tier, true);
  
  await auditLog({
    accountId: attempt.accountId,
    eventType: 'RECOVERY_CANCELLED',
    severity: 'INFO',
    description: `Recovery cancelled by ${cancelledBy}`,
    metadata: { attemptId, tier: attempt.tier },
  });
  
  return { success: true };
}

/**
 * Complete recovery (after approval or timeout)
 */
async function completeRecovery(attemptId: string, completedBy: string) {
  const attempt = await prisma.recoveryAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new Error('RECOVERY_ATTEMPT_NOT_FOUND');
  
  await prisma.recoveryAttempt.update({
    where: { id: attemptId },
    data: { status: 'COMPLETED', completedAt: new Date(), cancelledBy: completedBy },
  });
  
  // Revoke all sessions (force re-login)
  await prisma.session.updateMany({
    where: { accountId: attempt.accountId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'RECOVERY_COMPLETED' },
  });
  
  // Lock sensitive actions for 48-72 hours
  await require('./auth').setSecurityCooldown(attempt.accountId, 'RECOVERY', 72);
  
  await auditLog({
    accountId: attempt.accountId,
    eventType: 'RECOVERY_COMPLETED',
    severity: 'WARNING',
    description: `Recovery completed: ${attempt.tier}`,
    metadata: { attemptId, tier: attempt.tier, completedBy },
  });
}

/**
 * Verify recovery code
 */
export async function verifyRecoveryCode(accountId: string, code: string): Promise<boolean> {
  const codes = await prisma.recoveryCode.findMany({
    where: { accountId, usedAt: null },
  });
  
  for (const rc of codes) {
    const testHash = require('../lib/crypto').hashOtp(code, rc.batchId, process.env.JWT_SECRET!);
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
 * Alert all channels about recovery
 */
async function alertAllRecoveryChannels(
  accountId: string, 
  attemptId: string, 
  tier: string, 
  cancelled: boolean = false
) {
  // In-app alert
  await createInboxMessage({
    accountId,
    type: 'SECURITY_ALERT',
    category: 'SECURITY',
    subject: cancelled ? 'Recovery Cancelled' : 'Recovery Initiated',
    body: cancelled 
      ? 'A recovery request was cancelled.' 
      : `A recovery request was initiated (${tier}). If this wasn't you, cancel immediately from a trusted device.`,
    priority: 'CRITICAL',
    payload: { attemptId, tier, cancelled },
  });
  
  // Push to trusted devices
  const devices = await prisma.device.findMany({ where: { accountId, isTrusted: true } });
  for (const device of devices) {
    await sendPush(accountId, {
      title: cancelled ? 'Recovery Cancelled' : 'Recovery Alert',
      body: cancelled 
        ? 'A recovery request was cancelled.' 
        : `Recovery initiated (${tier}). Tap to review.`,
      deepLink: `/recovery/${attemptId}`,
      priority: 'high',
    });
  }
  
  // SMS to all verified numbers
  const bindings = await prisma.phoneBinding.findMany({
    where: { accountId, status: 'ACTIVE', roleFlags: { has: 'RECOVERY' } },
  });
  
  for (const binding of bindings) {
    const phone = require('../lib/crypto').decryptPii(binding.e164Encrypted);
    await sendSmsNotification(phone, 
      cancelled 
        ? 'PhoneMail: Recovery request cancelled.' 
        : `PhoneMail: Recovery initiated (${tier}). If not you, open app to cancel.`
    );
  }
}

/**
 * Get recovery status
 */
export async function getRecoveryStatus(accountId: string) {
  return prisma.recoveryAttempt.findFirst({
    where: { accountId, status: { in: ['INITIATED', 'PENDING_APPROVAL', 'WAITING_PERIOD'] } },
    orderBy: { initiatedAt: 'desc' },
  });
}

/**
 * Add trusted contact
 */
export async function addTrustedContact(accountId: string, contactHandle: string) {
  const contactAccount = await prisma.account.findUnique({ where: { handle: contactHandle } });
  if (!contactAccount) throw new Error('CONTACT_NOT_FOUND');
  if (contactAccount.id === accountId) throw new Error('CANNOT_ADD_SELF');
  
  const existing = await prisma.trustedContact.findUnique({
    where: { accountId_contactAccountId: { accountId, contactAccountId: contactAccount.id } },
  });
  
  if (existing) throw new Error('CONTACT_ALREADY_TRUSTED');
  
  const contact = await prisma.trustedContact.create({
    data: {
      accountId,
      contactAccountId: contactAccount.id,
      contactName: contactAccount.displayName,
      contactHandle: contactAccount.handle,
    },
  });
  
  // Notify contact
  await createInboxMessage({
    accountId: contactAccount.id,
    type: 'SECURITY_ALERT',
    category: 'SECURITY',
    subject: 'Trusted Contact Request',
    body: `${contactAccount.displayName} added you as a trusted contact for account recovery.`,
    priority: 'NORMAL',
    payload: { contactId: contact.id, type: 'TRUSTED_CONTACT_ADDED' },
  });
  
  return contact;
}

/**
 * Confirm trusted contact (contact accepts)
 */
export async function confirmTrustedContact(contactId: string, accountId: string) {
  const contact = await prisma.trustedContact.findFirst({
    where: { id: contactId, contactAccountId: accountId },
  });
  
  if (!contact) throw new Error('CONTACT_REQUEST_NOT_FOUND');
  
  return prisma.trustedContact.update({
    where: { id: contactId },
    data: { confirmedAt: new Date() },
  });
}