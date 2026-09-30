import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { prisma } from '../lib/prisma';
import { handleSmsStatusWebhook, handleInboundSms } from '../services/sms';
import { handleVoiceStatusWebhook, generateVoiceOtpTwiML, generateReplayTwiML, generateInboundIvrTwiML, handleInboundIvrMenu } from '../services/voice';
import { notificationQueue } from '../queues/notification.queue';

const router = Router();
// VoiceResponse is for calls; .message() only exists on MessagingResponse, which
// is what an SMS reply has to be built with.
const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

// ============================================================
// TWILIO SMS WEBHOOKS
// ============================================================

// SMS delivery status callback
router.post('/webhooks/sms/status', async (req: Request, res: Response) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, To, From } = req.body;

    await handleSmsStatusWebhook(MessageSid, MessageStatus, ErrorCode);

    // Also update the conversation copy, so the sender sees delivery ticks
    // without a refetch.
    if (MessageSid) {
      const { applyDeliveryStatus, smsStatusFromCarrier } = await import('../services/messages');
      await applyDeliveryStatus(
        MessageSid,
        smsStatusFromCarrier(MessageStatus),
        ErrorCode ? String(ErrorCode) : undefined
      );
    }

    res.status(200).send('OK');
  } catch (error: any) {
    console.error('SMS status webhook error:', error);
    res.status(500).send('ERROR');
  }
});

// Inbound SMS (replies, STOP/HELP)
router.post('/webhooks/sms/inbound', async (req: Request, res: Response) => {
  try {
    const { From, Body, MessageSid } = req.body;

    if (!From || !Body) {
      // 400 rather than 500: nothing the carrier retries will make these
      // parameters appear.
      return res.status(400).send('MISSING_PARAMS');
    }

    // STOP / START / HELP are carrier keywords, not conversation messages, and
    // get an immediate auto-reply.
    const result = await handleInboundSms(From, Body);

    if (result.message) {
      const twiml = new MessagingResponse();
      twiml.message(result.message);
      return res.type('text/xml').send(twiml.toString());
    }

    // Anything else is a real text. It used to be discarded here, which meant
    // replies were unreachable; it now lands in the sender's conversation.
    const { receiveText } = await import('../services/messages');
    const stored = await receiveText(
      From,
      Body,
      typeof MessageSid === 'string' ? MessageSid : undefined
    );
    console.log(
      `[Inbound SMS] ${stored.stored ? `stored (${stored.count} thread(s))` : `ignored (${stored.reason})`}`
    );

    res.status(200).send('OK');
  } catch (error: any) {
    console.error('Inbound SMS webhook error:', error);
    res.status(500).send('ERROR');
  }
});

// ============================================================
// TWILIO VOICE WEBHOOKS
// ============================================================

// Outbound voice OTP - TwiML for reading OTP
router.post('/webhooks/voice/otp', async (req: Request, res: Response) => {
  try {
    const { challengeId } = req.query;
    
    if (!challengeId) {
      const twiml = new VoiceResponse();
      twiml.say('Invalid request.');
      return res.type('text/xml').send(twiml.toString());
    }
    
    const otp = await require('../services/voice').getOtpForVoiceReadout(challengeId as string);
    const twiml = require('../services/voice').generateVoiceOtpTwiML(otp, challengeId as string);
    
    res.type('text/xml').send(twiml);
  } catch (error: any) {
    console.error('Voice OTP webhook error:', error);
    const twiml = new VoiceResponse();
    twiml.say('Unable to retrieve verification code. Please try again.');
    res.type('text/xml').send(twiml.toString());
  }
});

// Voice OTP replay
router.post('/webhooks/voice/replay', async (req: Request, res: Response) => {
  try {
    const { challengeId } = req.query;
    const { Digits } = req.body;
    
    const twiml = require('../services/voice').generateReplayTwiML(challengeId as string, Digits);
    res.type('text/xml').send(twiml);
  } catch (error: any) {
    console.error('Voice replay webhook error:', error);
    const twiml = new VoiceResponse();
    twiml.say('Goodbye.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// Voice call status callback
router.post('/webhooks/voice/status', async (req: Request, res: Response) => {
  try {
    const { CallSid, CallStatus } = req.body;
    
    await handleVoiceStatusWebhook(CallSid, CallStatus);
    
    res.status(200).send('OK');
  } catch (error: any) {
    console.error('Voice status webhook error:', error);
    res.status(500).send('ERROR');
  }
});

// Inbound IVR - welcome menu
router.post('/webhooks/voice/inbound', async (req: Request, res: Response) => {
  try {
    const twiml = require('../services/voice').generateInboundIvrTwiML();
    res.type('text/xml').send(twiml);
  } catch (error: any) {
    console.error('Inbound IVR error:', error);
    const twiml = new VoiceResponse();
    twiml.say('Service temporarily unavailable. Goodbye.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// Inbound IVR - menu selection
router.post('/webhooks/voice/inbound-menu', async (req: Request, res: Response) => {
  try {
    const { Digits, From } = req.body;
    
    const twiml = await handleInboundIvrMenu(Digits, From);
    res.type('text/xml').send(twiml);
  } catch (error: any) {
    console.error('Inbound IVR menu error:', error);
    const twiml = new VoiceResponse();
    twiml.say('Invalid option. Goodbye.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// ============================================================
// MAILGUN/EMAIL PROXY WEBHOOKS (for vendor emails)
// ============================================================

// Inbound email to proxy address
router.post('/webhooks/email/inbound', async (req: Request, res: Response) => {
  try {
    // Mailgun posts multipart/form-data
    const { recipient, sender, subject, 'body-plain': bodyPlain, 'body-html': bodyHtml, 'message-headers': headers } = req.body;
    
    // Extract proxy email local part
    const proxyMatch = recipient?.match(/^([^@]+)@/);
    if (!proxyMatch) return res.status(400).send('Invalid recipient');
    
    const localPart = proxyMatch[1];
    
    // Find proxy email
    const proxyEmail = await prisma.proxyEmail.findUnique({
      where: { localPart_domain: { localPart, domain: process.env.PROXY_EMAIL_DOMAIN! } },
      include: { account: true },
    });
    
    if (!proxyEmail || !proxyEmail.isActive) {
      return res.status(404).send('Proxy not found');
    }
    
    // Create inbox message
    await require('../services/inbox').createInboxMessage({
      accountId: proxyEmail.accountId,
      type: 'SYSTEM',
      category: 'SYSTEM',
      subject: subject || 'Vendor Email',
      body: bodyPlain?.substring(0, 500) || bodyHtml?.substring(0, 500) || 'Email received',
      payload: {
        from: sender,
        subject,
        bodyPlain,
        bodyHtml,
        headers: headers ? JSON.parse(headers) : {},
        proxyEmail: `${localPart}@${process.env.PROXY_EMAIL_DOMAIN}`,
        vendor: proxyEmail.vendor,
      },
      priority: 'NORMAL',
      sourceId: proxyEmail.vendorId,
      sourceType: 'vendor_email',
    });
    
    // Update last used
    await prisma.proxyEmail.update({
      where: { id: proxyEmail.id },
      data: { lastUsedAt: new Date() },
    });
    
    res.status(200).send('OK');
  } catch (error: any) {
    console.error('Inbound email webhook error:', error);
    res.status(500).send('ERROR');
  }
});

// ============================================================
// GENERIC NOTIFICATION CALLBACKS
// ============================================================

// FCM/APNs token registration (from mobile apps)
router.post('/webhooks/push/token', async (req: Request, res: Response) => {
  try {
    const { deviceId, token, type } = req.body; // type: 'fcm' | 'webpush'
    
    if (!deviceId || !token || !type) {
      return res.status(400).json({ error: 'MISSING_PARAMS' });
    }
    
    await require('../services/push').registerPushToken(deviceId, token, type);
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Push token webhook error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Health check for webhook endpoints
router.get('/webhooks/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;