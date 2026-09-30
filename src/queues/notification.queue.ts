// src/queues/notification.queue.ts
import { Queue, RepeatOptions, Job } from 'bullmq';

// Lazy initialization - only create when first accessed
let _notificationQueue: Queue | null = null;

function getNotificationQueue(): Queue {
  if (!_notificationQueue) {
    console.log('[Queue] Initializing notification queue...');
    try {
      const redisUrl = process.env.REDIS_URL;
      console.log('[Queue] Redis URL:', redisUrl);
      
      if (!redisUrl) {
        throw new Error('REDIS_URL not configured');
      }
      
      const connection = { 
        connection: { 
          url: redisUrl,
          maxRetriesPerRequest: 3,
          retryStrategy: (times: number) => {
            console.log(`[Queue] Redis retry attempt ${times}`);
            return Math.min(times * 100, 3000);
          }
        } 
      } as any;
      
      _notificationQueue = new Queue('notifications', connection);
      
      // Queue event handlers for monitoring
      _notificationQueue.on('error', (error: Error) => {
        console.error('[Queue] Error:', error);
      });
      
      _notificationQueue.on('waiting', (job: Job) => {
        console.log(`[Queue] Job ${job.id} (${job.name}) waiting`);
      });
      
      console.log('[Queue] Notification queue initialized successfully');
    } catch (error) {
      console.error('[Queue] Failed to initialize:', error);
      throw error;
    }
  }
  return _notificationQueue;
}

export const notificationQueue = {
  add: (name: string, data: any, opts?: any) => {
    console.log(`[Queue] Adding job: ${name}`, data);
    return getNotificationQueue().add(name, data, opts);
  },
  close: () => {
    console.log('[Queue] Closing queue...');
    return _notificationQueue?.close();
  },
} as any;

// Job names as constants for type safety
export const JobNames = {
  OTP_DELIVERY_CHECK: 'otp-delivery-check',
  DELIVER_NOTIFICATION: 'deliver-notification',
  PUSH_WITH_SMS_FALLBACK: 'push-with-sms-fallback',
  SMS_FALLBACK: 'sms-fallback',
  CLEANUP_EXPIRED_OTPS: 'cleanup-expired-otps',
  SIM_SWAP_CHECK: 'sim-swap-check',
  SECURITY_COOLDOWN_CHECK: 'security-cooldown-check',
  DORMANCY_CHECK: 'dormancy-check',
  RECOVERY_TIMEOUT: 'recovery-timeout',
  NUMBER_CHANGE_LOCK: 'number-change-lock',
} as const;

export type JobName = typeof JobNames[keyof typeof JobNames];

// Helper functions to add jobs with proper typing
export async function addOtpDeliveryCheck(challengeId: string, phone: string, fallback = false) {
  console.log(`[Queue] Scheduling OTP delivery check for ${challengeId}`);
  return notificationQueue.add(JobNames.OTP_DELIVERY_CHECK, { challengeId, phone, fallback }, { delay: 25000 });
}

export async function addDeliverNotification(messageId: string, channel: string) {
  console.log(`[Queue] Scheduling notification delivery: ${messageId} via ${channel}`);
  return notificationQueue.add(JobNames.DELIVER_NOTIFICATION, { messageId, channel }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export async function addPushWithSmsFallback(userId: string, payload: any) {
  console.log(`[Queue] Scheduling push with SMS fallback for user ${userId}`);
  return notificationQueue.add(JobNames.PUSH_WITH_SMS_FALLBACK, { userId, payload });
}

export async function addSmsFallback(userId: string, payload: any) {
  console.log(`[Queue] Scheduling SMS fallback for user ${userId}`);
  return notificationQueue.add(JobNames.SMS_FALLBACK, { userId, payload }, { delay: 3000 });
}

export async function addSimSwapCheck(phoneBindingId: string) {
  console.log(`[Queue] Scheduling SIM swap check for ${phoneBindingId}`);
  return notificationQueue.add(JobNames.SIM_SWAP_CHECK, { phoneBindingId });
}

export async function addSecurityCooldownCheck(accountId: string) {
  console.log(`[Queue] Scheduling security cooldown check for account ${accountId}`);
  return notificationQueue.add(JobNames.SECURITY_COOLDOWN_CHECK, { accountId });
}

export async function addRecoveryTimeout(recoveryAttemptId: string) {
  console.log(`[Queue] Scheduling recovery timeout for ${recoveryAttemptId}`);
  return notificationQueue.add(JobNames.RECOVERY_TIMEOUT, { recoveryAttemptId }, {
    jobId: `recovery-timeout-${recoveryAttemptId}`,
  });
}

export async function addNumberChangeLock(accountId: string) {
  console.log(`[Queue] Scheduling number change lock for account ${accountId}`);
  return notificationQueue.add(JobNames.NUMBER_CHANGE_LOCK, { accountId });
}

// Repeatable cleanup job
export async function scheduleRecurringJobs() {
  console.log('[Queue] Scheduling recurring jobs...');
  
  try {
    // Cleanup expired OTPs every 5 minutes
    const cleanupOpts: RepeatOptions = { every: 5 * 60 * 1000 };
    await notificationQueue.add(JobNames.CLEANUP_EXPIRED_OTPS, {}, {
      repeat: cleanupOpts,
      jobId: 'cleanup-expired-otps',
      removeOnFail: { count: 3 },
    } as any);
    console.log('[Queue] Scheduled cleanup-expired-otps');
    
    // Dormancy check daily at 3 AM UTC
    const dormancyOpts: RepeatOptions = { pattern: '0 3 * * *' };
    await notificationQueue.add(JobNames.DORMANCY_CHECK, {}, {
      repeat: dormancyOpts,
      jobId: 'dormancy-check',
      removeOnFail: { count: 3 },
    } as any);
    console.log('[Queue] Scheduled dormancy-check');
    
    // SIM swap signal check for recent verifications (hourly)
    const simSwapOpts: RepeatOptions = { every: 60 * 60 * 1000 };
    await notificationQueue.add(JobNames.SIM_SWAP_CHECK, {}, {
      repeat: simSwapOpts,
      jobId: 'sim-swap-check',
      removeOnFail: { count: 3 },
    } as any);
    console.log('[Queue] Scheduled sim-swap-check');
    
    // Security cooldown check every 15 minutes
    const cooldownOpts: RepeatOptions = { every: 15 * 60 * 1000 };
    await notificationQueue.add(JobNames.SECURITY_COOLDOWN_CHECK, {}, {
      repeat: cooldownOpts,
      jobId: 'security-cooldown-check',
      removeOnFail: { count: 3 },
    } as any);
    console.log('[Queue] Scheduled security-cooldown-check');
    
    console.log('[Queue] All recurring jobs scheduled successfully');
  } catch (error) {
    console.error('[Queue] Failed to schedule recurring jobs:', error);
    throw error;
  }
}

export async function closeQueue() {
  console.log('[Queue] Closing queue...');
  await _notificationQueue?.close();
}