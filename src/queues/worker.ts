// src/queues/worker.ts
import { Worker, Job, RepeatOptions } from 'bullmq';
import { prisma } from '../lib/prisma';
import { processDelivery } from '../services/inbox';
import { sendPush } from '../services/push';
import { getPrimaryPhone, sendSmsNotification } from '../services/phone';
import { notificationQueue, JobNames } from './notification.queue';

// Lazy initialization
let _notificationWorker: Worker | null = null;

function getNotificationWorker(): Worker {
  if (!_notificationWorker) {
    console.log('[Worker] Initializing notification worker...');
    try {
      const redisUrl = process.env.REDIS_URL;
      console.log('[Worker] Redis URL:', redisUrl);
      
      if (!redisUrl) {
        throw new Error('REDIS_URL not configured');
      }
      
      const connection = { 
        connection: { 
          url: redisUrl,
          maxRetriesPerRequest: 3,
          retryStrategy: (times: number) => {
            console.log(`[Worker] Redis retry attempt ${times}`);
            return Math.min(times * 100, 3000);
          }
        } 
      } as any;
      
      _notificationWorker = new Worker('notifications', async (job: Job) => {
        console.log(`[Worker] Processing job: ${job.name}`, job.data);
        
        try {
          switch (job.name) {
            case 'otp-delivery-check':
              await handleOtpDeliveryCheck(job.data);
              break;
              
            case 'deliver-notification':
              await processDelivery(job.data.messageId, job.data.channel);
              break;
              
            case 'push-with-sms-fallback':
              await handlePushWithSmsFallback(job.data);
              break;
              
            case 'sms-fallback':
              await handleSmsFallback(job.data);
              break;
              
            case 'cleanup-expired-otps':
              await cleanupExpiredOtps();
              break;
              
            case 'sim-swap-check':
              await handleSimSwapCheck(job.data);
              break;
              
            case 'security-cooldown-check':
              await handleSecurityCooldownCheck(job.data);
              break;
              
            case 'dormancy-check':
              await handleDormancyCheck();
              break;
              
            case 'recovery-timeout':
              await handleRecoveryTimeout(job.data);
              break;
              
            case 'number-change-lock':
              await handleNumberChangeLock(job.data);
              break;
              
            default:
              console.warn(`[Worker] Unknown job type: ${job.name}`);
          }
        } catch (error) {
          console.error(`[Worker] Job ${job.name} failed:`, error);
          throw error;
        }
      }, connection);

      // Worker event handlers
      _notificationWorker.on('error', (error: Error) => {
        console.error('[Worker] Error:', error);
      });

      _notificationWorker.on('failed', (job: Job | undefined, error: Error) => {
        console.error(`[Worker] Job ${job?.name} (${job?.id}) failed:`, error);
      });

      _notificationWorker.on('completed', (job: Job) => {
        if (process.env.NODE_ENV === 'development') {
          console.log(`[Worker] Job ${job.name} (${job.id}) completed`);
        }
      });

      _notificationWorker.on('active', (job: Job) => {
        console.log(`[Worker] Job ${job.name} (${job.id}) started`);
      });

      _notificationWorker.on('stalled', (jobId: string) => {
        console.warn(`[Worker] Job ${jobId} stalled`);
      });

      console.log('[Worker] Notification worker initialized successfully');
    } catch (error) {
      console.error('[Worker] Failed to initialize:', error);
      throw error;
    }
  }
  return _notificationWorker;
}

// Export accessor
export const notificationWorker = {
  get: () => getNotificationWorker(),
  close: () => _notificationWorker?.close(),
} as any;

async function handleOtpDeliveryCheck(data: { challengeId: string; phone: string; fallback?: boolean }) {
  console.log('[Worker] Checking OTP delivery:', data);
  const { challengeId, phone, fallback } = data;
  
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
  if (!challenge) {
    console.log('[Worker] Challenge not found:', challengeId);
    return;
  }
  
  const status = String(challenge.status);
  if (status === 'VERIFIED') return;
  
  const delivered = status === 'DELIVERED' || status === 'VERIFIED';
  
  if (!delivered && !fallback) {
    console.log(`[Worker] SMS delivery failed for ${challengeId}, triggering voice fallback`);
    const { sendVoiceOtp } = await import('../services/voice');
    await sendVoiceOtp(phone, challengeId);
  } else if (!delivered && fallback) {
    await prisma.otpChallenge.update({
      where: { id: challengeId },
      data: { status: 'FAILED' },
    });
    
    await prisma.auditLog.create({
      data: {
        eventType: 'OTP_FAILED',
        severity: 'WARNING',
        description: 'OTP delivery failed on all channels',
        metadata: { challengeId, phone: phone.substring(0, 3) + '***' },
      },
    });
  }
}

async function handlePushWithSmsFallback(data: { userId: string; payload: any }) {
  console.log('[Worker] Push with SMS fallback for user:', data.userId);
  const pushed = await sendPush(data.userId, data.payload);
  if (!pushed) {
    console.log('[Worker] Push failed, scheduling SMS fallback');
    await notificationQueue.add('sms-fallback', { userId: data.userId, payload: data.payload }, { delay: 3000 });
  }
}

async function handleSmsFallback(data: { userId: string; payload: any }) {
  console.log('[Worker] SMS fallback for user:', data.userId);
  const phone = await getPrimaryPhone(data.userId);
  if (phone) {
    await sendSmsNotification(phone, data.payload.summary || data.payload.body);
  }
}

async function cleanupExpiredOtps() {
  console.log('[Worker] Cleaning up expired OTPs...');
  try {
    const deletedBindings = await prisma.phoneBinding.deleteMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
    });
    console.log(`[Worker] Deleted ${deletedBindings.count} pending phone bindings`);
    
    const deletedChallenges = await prisma.otpChallenge.deleteMany({
      where: { 
        status: { in: ['VERIFIED', 'EXPIRED', 'FAILED', 'REVOKED'] },
        createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    console.log(`[Worker] Deleted ${deletedChallenges.count} old challenges`);
  } catch (error) {
    console.error('[Worker] Cleanup failed:', error);
  }
}

async function handleSimSwapCheck(data: { phoneBindingId: string }) {
  console.log('[Worker] SIM swap check for:', data.phoneBindingId);
  const { detectSimSwapSignals } = await import('../services/phone');
  await detectSimSwapSignals(data.phoneBindingId);
}

async function handleSecurityCooldownCheck(data: { accountId: string }) {
  console.log('[Worker] Security cooldown check for account:', data.accountId);
  try {
    const account = await prisma.account.findUnique({ where: { id: data.accountId } });
    if (!account?.metadata) return;
    
    const meta = account.metadata as any;
    if (meta.cooldownUntil && new Date(meta.cooldownUntil) <= new Date()) {
      console.log('[Worker] Cooldown expired for account:', data.accountId);
      await prisma.account.update({
        where: { id: data.accountId },
        data: { metadata: { ...meta, cooldownUntil: null, cooldownReason: null } },
      });
    }
  } catch (error) {
    console.error('[Worker] Security cooldown check failed:', error);
  }
}

async function handleDormancyCheck() {
  console.log('[Worker] Running dormancy check...');
  try {
    const sixMonthsAgo = new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000);
    
    const dormantAccounts = await prisma.account.findMany({
      where: {
        status: 'ACTIVE',
        lastActiveAt: { lt: sixMonthsAgo },
      },
      select: { id: true },
    });
    
    console.log(`[Worker] Found ${dormantAccounts.length} dormant accounts`);
    
    for (const account of dormantAccounts) {
      await prisma.account.update({
        where: { id: account.id },
        data: { status: 'DORMANT' },
      });
      
      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          eventType: 'SUSPICIOUS_ACTIVITY',
          severity: 'INFO',
          description: 'Account marked dormant due to inactivity',
        },
      });
    }
  } catch (error) {
    console.error('[Worker] Dormancy check failed:', error);
  }
}

async function handleRecoveryTimeout(data: { recoveryAttemptId: string }) {
  console.log('[Worker] Recovery timeout for:', data.recoveryAttemptId);
  try {
    const attempt = await prisma.recoveryAttempt.findUnique({ where: { id: data.recoveryAttemptId } });
    if (!attempt || attempt.status !== 'WAITING_PERIOD') return;
    
    if (attempt.cancelledAt) return;
    
    await prisma.recoveryAttempt.update({
      where: { id: data.recoveryAttemptId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    
    console.log(`[Worker] Recovery timeout completed for attempt ${data.recoveryAttemptId}`);
  } catch (error) {
    console.error('[Worker] Recovery timeout failed:', error);
  }
}

async function handleNumberChangeLock(data: { accountId: string }) {
  console.log('[Worker] Number change lock check for account:', data.accountId);
  try {
    const account = await prisma.account.findUnique({ where: { id: data.accountId } });
    if (!account?.metadata) return;
    
    const meta = account.metadata as any;
    if (meta.cooldownUntil && new Date(meta.cooldownUntil) <= new Date()) {
      console.log('[Worker] Cooldown expired for account:', data.accountId);
      await prisma.account.update({
        where: { id: data.accountId },
        data: { metadata: { ...meta, cooldownUntil: null, cooldownReason: null } },
      });
    }
  } catch (error) {
    console.error('[Worker] Number change lock check failed:', error);
  }
}

// Scheduled recurring jobs
export async function scheduleRecurringJobs() {
  console.log('[Worker] Scheduling recurring jobs...');
  try {
    // Cleanup expired OTPs every 5 minutes
    const cleanupOpts: RepeatOptions = { every: 5 * 60 * 1000 };
    await notificationQueue.add('cleanup-expired-otps', {}, {
      repeat: cleanupOpts,
      jobId: 'cleanup-expired-otps',
      removeOnFail: { count: 3 },
    } as any);
    console.log('[Worker] Scheduled cleanup-expired-otps');
    
    // Dormancy check daily
    const dormancyOpts: RepeatOptions = { pattern: '0 3 * * *' };
    await notificationQueue.add('dormancy-check', {}, {
      repeat: dormancyOpts,
      jobId: 'dormancy-check',
      removeOnFail: { count: 3 },
    } as any);
    console.log('[Worker] Scheduled dormancy-check');
    
    // SIM swap signal check for recent verifications (hourly)
    const simSwapOpts: RepeatOptions = { every: 60 * 60 * 1000 };
    await notificationQueue.add('sim-swap-check', {}, {
      repeat: simSwapOpts,
      jobId: 'sim-swap-check',
      removeOnFail: { count: 3 },
    } as any);
    console.log('[Worker] Scheduled sim-swap-check');
    
    // Security cooldown check every 15 minutes
    const cooldownOpts: RepeatOptions = { every: 15 * 60 * 1000 };
    await notificationQueue.add('security-cooldown-check', {}, {
      repeat: cooldownOpts,
      jobId: 'security-cooldown-check',
      removeOnFail: { count: 3 },
    } as any);
    console.log('[Worker] Scheduled security-cooldown-check');
    
    console.log('[Worker] All recurring jobs scheduled successfully');
  } catch (error) {
    console.error('[Worker] Failed to schedule recurring jobs:', error);
    throw error;
  }
}

// Graceful shutdown
export async function shutdownWorkers() {
  console.log('[Worker] Shutting down workers...');
  if (_notificationWorker) {
    await _notificationWorker.close();
  }
  await notificationQueue.close();
  console.log('[Worker] Workers shut down successfully');
}

process.on('SIGTERM', () => {
  console.log('[Worker] SIGTERM received, shutting down...');
  shutdownWorkers();
});
process.on('SIGINT', () => {
  console.log('[Worker] SIGINT received, shutting down...');
  shutdownWorkers();
});