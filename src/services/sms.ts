import twilio from 'twilio';

let client: any = null;
let twilioInitialized = false;

function initTwilio() {
  if (twilioInitialized) return;
  
  // Force dev mode if explicitly set
  if (process.env.FORCE_DEV_MODE === 'true') {
    console.warn('FORCE_DEV_MODE enabled - Twilio disabled');
    twilioInitialized = false;
    return;
  }
  
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  
  if (sid && token && sid.startsWith('AC')) {
    client = twilio(sid, token);
    twilioInitialized = true;
  } else {
    console.warn('Twilio not configured - SMS/Voice features disabled');
  }
}

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const APP_DOMAIN = process.env.APP_DOMAIN || 'phonemail.app';

/**
 * Send SMS OTP with origin-bound format for autofill
 */
export async function sendSmsOtp(phone: string, otp: string) {
  initTwilio();
  
  if (!twilioInitialized || !FROM_NUMBER) {
    console.log(`[DEV MODE] SMS OTP to ${phone}: ${otp}`);
    return { sid: 'dev-mode-simulated', status: 'queued' };
  }
  
  const body = `${otp} is your PhoneMail code. ${APP_DOMAIN} requested this — never share it.`;
  
  const message = await client.messages.create({
    to: phone,
    from: FROM_NUMBER,
    body,
    statusCallback: `${process.env.WEBHOOK_BASE_URL}/webhooks/sms/status`,
  });
  
  return message;
}

/**
 * Send SMS notification (non-OTP)
 */
export async function sendSmsNotification(phone: string, body: string) {
  initTwilio();
  
  if (!twilioInitialized || !FROM_NUMBER) {
    console.log(`[DEV MODE] SMS Notification to ${phone}: ${body}`);
    return { sid: 'dev-mode-simulated', status: 'queued' };
  }
  
  const message = await client.messages.create({
    to: phone,
    from: FROM_NUMBER,
    body,
    statusCallback: `${process.env.WEBHOOK_BASE_URL}/webhooks/sms/status`,
  });
  
  return message;
}

/**
 * Handle inbound SMS (STOP/HELP keywords, replies)
 */
export async function handleInboundSms(from: string, body: string) {
  // A webhook with no payload is malformed, not a crash. Previously this threw
  // on body.trim() and turned a bad request into a 500 the carrier would retry.
  if (!from || !body) {
    return { action: 'MALFORMED', message: null as string | null };
  }

  const normalized = String(body).trim().toUpperCase();
  
  if (normalized === 'STOP' || normalized === 'STOPALL' || normalized === 'UNSUBSCRIBE') {
    await optOutPhone(from);
    return { action: 'OPT_OUT', message: 'You have been unsubscribed from all messages. Reply START to resubscribe.' };
  }
  
  if (normalized === 'START') {
    await optInPhone(from);
    return { action: 'OPT_IN', message: 'You have been resubscribed. Reply STOP to unsubscribe.' };
  }
  
  if (normalized === 'HELP') {
    return { action: 'HELP', message: 'PhoneMail: Reply STOP to unsubscribe, START to resubscribe. Visit phonemail.app for help.' };
  }
  
  return { action: 'UNKNOWN', message: null };
}

async function optOutPhone(phone: string) {
  const e164Hash = require('../lib/crypto').createBlindIndex(phone);
  const binding = await require('../lib/prisma').prisma.phoneBinding.findUnique({
    where: { e164Hash },
  });
  
  if (binding) {
    await require('../lib/prisma').prisma.consent.upsert({
      where: { 
        accountId_purpose_channel: { 
          accountId: binding.accountId, 
          purpose: 'MARKETING', 
          channel: 'SMS' 
        } 
      },
      create: { accountId: binding.accountId, purpose: 'MARKETING', channel: 'SMS', granted: false, version: '1.0' },
      update: { granted: false, revokedAt: new Date() },
    });
  }
}

async function optInPhone(phone: string) {
  const e164Hash = require('../lib/crypto').createBlindIndex(phone);
  const binding = await require('../lib/prisma').prisma.phoneBinding.findUnique({
    where: { e164Hash },
  });
  
  if (binding) {
    await require('../lib/prisma').prisma.consent.upsert({
      where: { 
        accountId_purpose_channel: { 
          accountId: binding.accountId, 
          purpose: 'MARKETING', 
          channel: 'SMS' 
        } 
      },
      create: { accountId: binding.accountId, purpose: 'MARKETING', channel: 'SMS', granted: true, grantedAt: new Date(), version: '1.0' },
      update: { granted: true, grantedAt: new Date(), revokedAt: null },
    });
  }
}

/**
 * Handle SMS delivery receipt webhook
 */
export async function handleSmsStatusWebhook(messageSid: string, status: string, errorCode?: string) {
  if (!twilioInitialized) return;
  
  await require('../lib/prisma').prisma.notificationDelivery.updateMany({
    where: { providerId: messageSid },
    data: { 
      status: mapTwilioStatus(status),
      deliveredAt: ['delivered', 'read'].includes(status) ? new Date() : undefined,
      failedAt: ['failed', 'undelivered'].includes(status) ? new Date() : undefined,
      error: errorCode,
    },
  });
  
  if (['failed', 'undelivered'].includes(status)) {
    const delivery = await require('../lib/prisma').prisma.notificationDelivery.findFirst({
      where: { providerId: messageSid },
      include: { message: true },
    });
    
    if (delivery?.message) {
      await require('../queues/notification.queue').notificationQueue.add(
        'sms-fallback',
        { messageId: delivery.messageId, reason: `SMS failed: ${status}` },
        { delay: 5000 }
      );
    }
  }
}

function mapTwilioStatus(status: string): any {
  switch (status) {
    case 'queued': return 'QUEUED';
    case 'sent': return 'SENT';
    case 'delivered': return 'DELIVERED';
    case 'read': return 'DELIVERED';
    case 'failed': return 'FAILED';
    case 'undelivered': return 'FAILED';
    default: return 'QUEUED';
  }
}