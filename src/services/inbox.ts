// src/services/inbox.ts
import { prisma } from '../lib/prisma';
import { sendPush } from './push';
import { sendSmsNotification } from './sms';
import { notificationQueue } from '../queues/notification.queue';

export interface CreateMessageParams {
  accountId: string;
  type: 'SECURITY_ALERT' | 'TRANSACTIONAL' | 'RECEIPT_INVOICE' | 'MARKETING' | 'LEGAL_NOTICE' | 'SYSTEM';
  category: 'AUTH' | 'SECURITY' | 'TRANSACTION' | 'BILLING' | 'MARKETING' | 'LEGAL' | 'SYSTEM';
  subject: string;
  body: string;
  payload?: any;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  sourceId?: string;
  sourceType?: string;
  expiresAt?: Date;
  channels?: ('IN_APP' | 'PUSH' | 'SMS' | 'EMAIL_PROXY')[];
}

/**
 * Create in-app message and route to channels based on preferences
 * In-app inbox is the system of record - other channels are pointers/mirrors
 */
export async function createInboxMessage(params: CreateMessageParams) {
  const {
    accountId,
    type,
    category,
    subject,
    body,
    payload,
    priority = 'NORMAL',
    sourceId,
    sourceType,
    expiresAt,
    channels,
  } = params;
  
  // Check user consent for marketing
  if (category === 'MARKETING') {
    const consent = await prisma.consent.findUnique({
      where: { accountId_purpose_channel: { accountId, purpose: 'MARKETING', channel: 'IN_APP' } },
    });
    if (!consent?.granted) {
      console.log(`Marketing message blocked - no consent for account ${accountId}`);
      return null;
    }
  }
  
  // Create message (system of record)
  const message = await prisma.inboxMessage.create({
    data: {
      accountId,
      type,
      category,
      subject,
      body,
      payload,
      priority,
      sourceId,
      sourceType,
      expiresAt,
    },
  });
  
  // Determine routing channels based on message type and user preferences
  const routingChannels = channels || getDefaultChannels(type, category);
  
  // Queue deliveries for each channel
  for (const channel of routingChannels) {
    await queueDelivery(message.id, channel);
  }
  
  return message;
}

function getDefaultChannels(
  type: CreateMessageParams['type'],
  category: CreateMessageParams['category']
): ('IN_APP' | 'PUSH' | 'SMS' | 'EMAIL_PROXY')[] {
  // Per guidance: In-app first, then channel-specific routing
  const base: ('IN_APP' | 'PUSH' | 'SMS' | 'EMAIL_PROXY')[] = ['IN_APP'];
  
  switch (type) {
    case 'SECURITY_ALERT':
      return [...base, 'PUSH', 'SMS']; // Mirror to all verified numbers
    case 'TRANSACTIONAL':
      return [...base, 'PUSH', 'SMS'];
    case 'RECEIPT_INVOICE':
      return [...base, 'PUSH']; // Full doc via in-app
    case 'MARKETING':
      return [...base, 'SMS']; // Opt-in only
    case 'LEGAL_NOTICE':
      return [...base, 'PUSH']; // In-app with banner, SMS pointer
    case 'SYSTEM':
      return [...base, 'PUSH'];
    default:
      return base;
  }
}

async function queueDelivery(messageId: string, channel: 'IN_APP' | 'PUSH' | 'SMS' | 'EMAIL_PROXY') {
  await notificationQueue.add('deliver-notification', { messageId, channel }, { 
    attempts: 3, 
    backoff: { type: 'exponential', delay: 5000 } 
  });
}

/**
 * Process notification delivery (called by queue worker)
 */
export async function processDelivery(messageId: string, channel: string) {
  const message = await prisma.inboxMessage.findUnique({ where: { id: messageId } });
  if (!message) return { success: false, reason: 'MESSAGE_NOT_FOUND' };
  
  const account = await prisma.account.findUnique({ where: { id: message.accountId } });
  if (!account) return { success: false, reason: 'ACCOUNT_NOT_FOUND' };
  
  let success = false;
  let providerId: string | undefined;
  let error: string | undefined;
  let cost: number | undefined;
  
  try {
    switch (channel) {
      case 'IN_APP':
        success = true; // Already created
        break;
        
      case 'PUSH':
        success = await sendPush(message.accountId, {
          title: message.subject,
          body: message.body,
          deepLink: `/inbox/${message.id}`,
          data: { messageId: message.id, type: message.type },
          priority: message.priority === 'CRITICAL' || message.priority === 'HIGH' ? 'high' : 'normal',
        });
        break;
        
      case 'SMS':
        const bindings = await prisma.phoneBinding.findMany({
          where: { accountId: message.accountId, status: 'ACTIVE', roleFlags: { has: 'NOTIFICATIONS' } },
        });
        
        for (const binding of bindings) {
          const phone = require('../lib/crypto').decryptPii(binding.e164Encrypted);
          const result = await sendSmsNotification(phone, `${message.subject}: ${message.body}`);
          if (result) {
            success = true;
            providerId = result.sid;
            cost = parseFloat(result.price || '0');
          }
        }
        break;
        
      case 'EMAIL_PROXY':
        // Route to proxy email inbound bridge
        success = await routeToProxyEmail(message);
        break;
    }
  } catch (err: any) {
    error = err.message;
    console.error(`Delivery failed for ${channel}:`, err);
  }
  
  // Record delivery attempt
  await prisma.notificationDelivery.create({
    data: {
      messageId,
      channel: channel as any,
      recipient: account.id,
      provider: getProvider(channel),
      providerId,
      status: success ? 'DELIVERED' : 'FAILED',
      deliveredAt: success ? new Date() : undefined,
      failedAt: !success ? new Date() : undefined,
      error,
      cost: cost ? cost.toFixed(4) : undefined,
    },
  });
  
  // If critical and failed, escalate
  if (!success && message.priority === 'CRITICAL') {
    await escalateDelivery(message, channel);
  }
  
  return { success, error };
}

function getProvider(channel: string): string {
  switch (channel) {
    case 'PUSH': return 'firebase';
    case 'SMS': return 'twilio';
    case 'EMAIL_PROXY': return 'mailgun';
    default: return 'internal';
  }
}

async function routeToProxyEmail(message: any): Promise<boolean> {
  // Forward to inbound email bridge for vendor communications
  // This would send to the proxy email address associated with the account
  console.log('Routing to proxy email bridge:', message.id);
  return true;
}

async function escalateDelivery(message: any, failedChannel: string) {
  console.warn(`CRITICAL message delivery failed on ${failedChannel}: ${message.id}`);
  
  // Create escalation alert
  await prisma.inboxMessage.create({
    data: {
      accountId: message.accountId,
      type: 'SECURITY_ALERT',
      category: 'SYSTEM',
      subject: 'Message Delivery Failure',
      body: `Critical message "${message.subject}" failed to deliver via ${failedChannel}.`,
      priority: 'CRITICAL',
      payload: { originalMessageId: message.id, failedChannel },
    },
  });
  
  // Try alternative channels
  const alternatives = getAlternativeChannels(failedChannel);
  for (const alt of alternatives) {
    await queueDelivery(message.id, alt);
  }
}

function getAlternativeChannels(failedChannel: string): ('PUSH' | 'SMS')[] {
  switch (failedChannel) {
    case 'PUSH': return ['SMS'];
    case 'SMS': return ['PUSH'];
    default: return ['PUSH', 'SMS'];
  }
}

/**
 * Get user's inbox messages with pagination
 */
export async function getInboxMessages(
  accountId: string,
  options: {
    status?: 'UNREAD' | 'READ' | 'ARCHIVED';
    category?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  const { status, category, limit = 50, offset = 0 } = options;
  
  const where: any = { accountId };
  // Deletion is a soft delete (status DELETED). Without this exclusion the
  // unfiltered list kept returning deleted rows, so "Delete" looked like it
  // had done nothing. An explicit status filter still wins, including
  // status=DELETED if a caller ever wants the raw rows.
  if (status) where.status = status;
  else where.status = { not: 'DELETED' };
  if (category) where.category = category;
  
  const [messages, total] = await Promise.all([
    prisma.inboxMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.inboxMessage.count({ where }),
  ]);
  
  return { messages, total, limit, offset };
}

/**
 * Mark message as read
 */
export async function markMessageRead(accountId: string, messageId: string) {
  const message = await prisma.inboxMessage.findFirst({
    where: { id: messageId, accountId },
  });
  
  if (!message) throw new Error('MESSAGE_NOT_FOUND');
  
  return prisma.inboxMessage.update({
    where: { id: messageId },
    data: { status: 'READ', readAt: new Date() },
  });
}

/**
 * Acknowledge legal/policy notice
 */
export async function acknowledgeLegalNotice(accountId: string, messageId: string) {
  const message = await prisma.inboxMessage.findFirst({
    where: { id: messageId, accountId, type: 'LEGAL_NOTICE' },
  });
  
  if (!message) throw new Error('LEGAL_NOTICE_NOT_FOUND');
  
  return prisma.inboxMessage.update({
    where: { id: messageId },
    data: { status: 'READ', readAt: new Date(), acknowledgedAt: new Date() },
  });
}

/**
 * Archive message
 */
export async function archiveMessage(accountId: string, messageId: string) {
  return prisma.inboxMessage.update({
    where: { id: messageId, accountId },
    data: { status: 'ARCHIVED' },
  });
}

/**
 * Delete message
 */
export async function deleteMessage(accountId: string, messageId: string) {
  return prisma.inboxMessage.update({
    where: { id: messageId, accountId },
    data: { status: 'DELETED' },
  });
}

/**
 * Get unread count
 */
export async function getUnreadCount(accountId: string): Promise<number> {
  return prisma.inboxMessage.count({
    where: { accountId, status: 'UNREAD' },
  });
}