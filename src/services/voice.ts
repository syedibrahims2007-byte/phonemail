// src/services/voice.ts
import twilio from 'twilio';
import { prisma } from '../lib/prisma';

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
    console.warn('Twilio not configured - Voice features disabled');
  }
}

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const WEBHOOK_BASE = process.env.WEBHOOK_BASE_URL || `https://${process.env.APP_DOMAIN}`;

/**
 * Trigger outbound voice call with OTP
 */
export async function sendVoiceOtp(phone: string, challengeId: string) {
  initTwilio();
  
  if (!twilioInitialized || !FROM_NUMBER) {
    console.log(`[DEV MODE] Voice OTP call to ${phone} for challenge ${challengeId}`);
    return { sid: 'dev-mode-simulated', status: 'queued' };
  }
  
  const call = await client.calls.create({
    to: phone,
    from: FROM_NUMBER,
    url: `${WEBHOOK_BASE}/webhooks/voice/otp?challengeId=${challengeId}`,
    method: 'POST',
    statusCallback: `${WEBHOOK_BASE}/webhooks/voice/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
    machineDetection: 'DetectMessageEnd',
    machineDetectionTimeout: 5,
  });
  
  console.log(`Voice call initiated to ${phone}: ${call.sid}`);
  
  await prisma.otpChallenge.update({
    where: { id: challengeId },
    data: { metadata: { callSid: call.sid } },
  });
  
  return call;
}

/**
 * Get OTP for voice readout (server-side only)
 */
export async function getOtpForVoiceReadout(challengeId: string): Promise<string> {
  const challenge = await prisma.otpChallenge.findUnique({
    where: { id: challengeId },
    include: { phoneBinding: true },
  });
  
  if (!challenge || challenge.status !== 'DELIVERED') {
    throw new Error('Challenge not found or not delivered');
  }
  
  const redis = require('ioredis').default;
  const redisClient = new redis(process.env.REDIS_URL!);
  const otp = await redisClient.get(`voice:otp:${challengeId}`);
  
  if (!otp) {
    throw new Error('OTP not found for voice readout');
  }
  
  return otp;
}

/**
 * Store OTP for voice readout (called when challenge created)
 */
export async function storeOtpForVoice(challengeId: string, otp: string) {
  const redis = require('ioredis').default;
  const redisClient = new redis(process.env.REDIS_URL!);
  await redisClient.setex(`voice:otp:${challengeId}`, 300, otp);
}

/**
 * TwiML for voice OTP readout
 */
export function generateVoiceOtpTwiML(otp: string, challengeId: string) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  
  const say = (text: string) => twiml.say({ voice: 'Polly.Joanna' }, text);
  
  say('Hello. Your PhoneMail verification code is:');
  say(otp.split('').join(', '));
  twiml.pause({ length: 1 });
  say('Again, your code is:');
  say(otp.split('').join(', '));
  
  twiml.gather({
    numDigits: 1,
    action: `${WEBHOOK_BASE}/webhooks/voice/replay?challengeId=${challengeId}`,
    timeout: 5,
  }).say('Press 1 to hear the code again.');
  
  return twiml.toString();
}

/**
 * TwiML for replay
 */
export function generateReplayTwiML(challengeId: string, digit: string) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  
  if (digit === '1') {
    twiml.redirect(`${WEBHOOK_BASE}/webhooks/voice/otp?challengeId=${challengeId}`);
  } else {
    twiml.say('Goodbye.');
    twiml.hangup();
  }
  
  return twiml.toString();
}

/**
 * Inbound IVR: User calls toll-free number
 */
export function generateInboundIvrTwiML() {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  
  const gather = twiml.gather({
    numDigits: 1,
    action: `${WEBHOOK_BASE}/webhooks/voice/inbound-menu`,
    timeout: 5,
  });
  gather.say('Welcome to PhoneMail. Press 1 to create an account or log in. Press 2 for support.');
  
  return twiml.toString();
}

/**
 * Handle inbound IVR menu selection
 */
export async function handleInboundIvrMenu(digit: string, callerNumber: string) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  
  if (digit === '1') {
    const { createChallenge } = require('./otp');
    const result = await createChallenge(callerNumber, 'VOICE');
    
    await storeOtpForVoice(result.challengeId, result.otp);
    
    twiml.redirect(`${WEBHOOK_BASE}/webhooks/voice/otp?challengeId=${result.challengeId}`);
  } else if (digit === '2') {
    twiml.say('For support, please visit phonemail dot app slash support. Goodbye.');
    twiml.hangup();
  } else {
    twiml.say('Invalid option. Goodbye.');
    twiml.hangup();
  }
  
  return twiml.toString();
}

/**
 * Handle voice call status webhook
 */
export async function handleVoiceStatusWebhook(callSid: string, callStatus: string) {
  console.log(`Voice call ${callSid} status: ${callStatus}`);
  
  if (!twilioInitialized) return;
  
  await prisma.otpChallenge.updateMany({
    where: { metadata: { path: ['callSid'], equals: callSid } },
    data: { metadata: { callStatus } },
  });
  
  if (['failed', 'busy', 'no-answer', 'canceled'].includes(callStatus)) {
    const challenge = await prisma.otpChallenge.findFirst({
      where: { metadata: { path: ['callSid'], equals: callSid } },
      include: { phoneBinding: true },
    });
    
    if (challenge && challenge.phoneBinding) {
      const phone = require('../lib/crypto').decryptPii(challenge.phoneBinding.e164Encrypted);
      await require('../queues/notification.queue').notificationQueue.add(
        'otp-delivery-check',
        { challengeId: challenge.id, phone, fallback: true },
        { delay: 5000 }
      );
    }
  }
}