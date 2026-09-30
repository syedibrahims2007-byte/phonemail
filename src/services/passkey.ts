// src/services/passkey.ts - Simplified passkey service
// Note: @simplewebauthn/server API has changed significantly. 
// This is a simplified implementation - adjust based on actual library version.

import { prisma } from '../lib/prisma';
import { auditLog } from './auth';

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

const RP_ID = process.env.WEBAUTHN_RP_ID || 'phonemail.app';
const RP_NAME = 'PhoneMail';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://phonemail.app';

export interface PasskeyRegistrationStart {
  options: any;
  challenge: string;
}

export interface PasskeyAuthenticationStart {
  options: any;
  challenge: string;
}

/**
 * Start passkey registration (generate options)
 * This is a placeholder - implement based on your @simplewebauthn/server version
 */
export async function startPasskeyRegistration(accountId: string, deviceName?: string): Promise<PasskeyRegistrationStart> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error('ACCOUNT_NOT_FOUND');
  
  // TODO: Implement with actual @simplewebauthn/server API
  // For now, return a mock response structure
  const challenge = require('crypto').randomBytes(32).toString('base64');
  
  const options = {
    rp: { name: RP_NAME, id: RP_ID },
    user: { 
      id: accountId, 
      name: account.handle || account.id, 
      displayName: account.displayName || 'PhoneMail User' 
    },
    challenge: Buffer.from(challenge, 'base64'),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    timeout: 60000,
    attestation: 'direct',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  };
  
  // Store challenge for verification
  await getRedisClient().setex(`passkey:reg:${accountId}`, 300, challenge);
  
  return { options, challenge };
}

/**
 * Complete passkey registration
 * This is a placeholder - implement based on your @simplewebauthn/server version
 */
export async function completePasskeyRegistration(
  accountId: string,
  credential: any,
  deviceName?: string
) {
  const redisClient = getRedisClient();
  
  const expectedChallenge = await redisClient.get(`passkey:reg:${accountId}`);
  if (!expectedChallenge) throw new Error('CHALLENGE_EXPIRED');
  
  // TODO: Implement actual verification with @simplewebauthn/server
  // For now, just store the credential
  const credentialId = credential.id || require('crypto').randomUUID();
  
  await prisma.credential.create({
    data: {
      accountId,
      type: 'PASSKEY',
      publicKey: credential.rawId ? Buffer.from(credential.rawId).toString('base64') : 'placeholder',
      credentialId: Buffer.from(credentialId).toString('base64'),
      aaguid: undefined,
      signCount: 0,
      name: deviceName || 'Passkey',
      attestation: undefined,
    },
  });
  
  await redisClient.del(`passkey:reg:${accountId}`);
  
  await auditLog({
    accountId,
    eventType: 'PASSKEY_ENROLLED',
    severity: 'INFO',
    description: 'Passkey enrolled',
    metadata: { credentialId },
  });
  
  return { success: true };
}

/**
 * Start passkey authentication
 */
export async function startPasskeyAuthentication(accountId?: string): Promise<PasskeyAuthenticationStart> {
  const challenge = require('crypto').randomBytes(32).toString('base64');
  
  const options = {
    rpId: RP_ID,
    challenge: Buffer.from(challenge, 'base64'),
    timeout: 60000,
    userVerification: 'preferred',
  };
  
  // Store challenge
  const redisClient = getRedisClient();
  const challengeKey = accountId ? `passkey:auth:${accountId}` : 'passkey:auth:anon';
  await redisClient.setex(challengeKey, 300, challenge);
  
  return { options, challenge };
}

/**
 * Complete passkey authentication
 */
export async function completePasskeyAuthentication(
  credential: any,
  accountId?: string
) {
  const redisClient = getRedisClient();
  
  const challengeKey = accountId ? `passkey:auth:${accountId}` : 'passkey:auth:anon';
  const expectedChallenge = await redisClient.get(challengeKey);
  
  if (!expectedChallenge) throw new Error('CHALLENGE_EXPIRED');
  
  // Find credential in DB
  const credRecord = await prisma.credential.findFirst({
    where: { 
      accountId,
      type: 'PASSKEY',
      revokedAt: null,
    },
  });
  
  if (!credRecord) throw new Error('CREDENTIAL_NOT_FOUND');
  
  // TODO: Implement actual verification with @simplewebauthn/server
  // For now, just update sign count
  await prisma.credential.update({
    where: { id: credRecord.id },
    data: { 
      lastUsedAt: new Date(),
    },
  });
  
  await redisClient.del(challengeKey);
  
  await auditLog({
    accountId: credRecord.accountId,
    eventType: 'LOGIN_SUCCESS',
    severity: 'INFO',
    description: 'Login successful via passkey',
    metadata: { credentialId: credRecord.credentialId },
  });
  
  return { accountId: credRecord.accountId, credentialId: credRecord.id };
}

/**
 * List user's passkeys
 */
export async function listPasskeys(accountId: string) {
  return prisma.credential.findMany({
    where: { accountId, type: 'PASSKEY', revokedAt: null },
    select: {
      id: true,
      name: true,
      aaguid: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
}

/**
 * Revoke passkey
 */
export async function revokePasskey(accountId: string, credentialId: string) {
  const credential = await prisma.credential.findFirst({
    where: { id: credentialId, accountId, type: 'PASSKEY' },
  });
  
  if (!credential) throw new Error('PASSKEY_NOT_FOUND');
  
  await prisma.credential.update({
    where: { id: credentialId },
    data: { revokedAt: new Date() },
  });
  
  await auditLog({
    accountId,
    eventType: 'PASSKEY_REVOKED',
    severity: 'WARNING',
    description: 'Passkey revoked',
    metadata: { credentialId },
  });
  
  return { success: true };
}