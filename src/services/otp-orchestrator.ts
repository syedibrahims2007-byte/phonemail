// src/services/otp-orchestrator.ts
import { createChallenge } from './otp';
import { notificationQueue } from '../queues/notification.queue';

export async function requestOtp(
  phone: string, 
  preferredChannel: 'SMS' | 'VOICE' = 'SMS',
  options: {
    deviceId?: string;
    deviceFingerprint?: string;
    ipAddress?: string;
    purpose?: 'LOGIN' | 'REGISTER' | 'RECOVERY' | 'NUMBER_CHANGE' | 'VERIFY_NUMBER';
  } = {}
) {
  const result = await createChallenge(phone, preferredChannel, options);
  
  // Schedule delivery check
  await notificationQueue.add('otp-delivery-check', { 
    challengeId: result.challengeId, 
    phone 
  }, { delay: 25000 });
  
  return { 
    challengeId: result.challengeId,
    channel: result.channel,
    expiresIn: 300,
  };
}

export { createChallenge, verifyOtp } from './otp';