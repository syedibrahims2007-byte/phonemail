// src/services/messages.ts
//
// SMS conversations. Phone numbers are treated as PII throughout: a thread stores
// a blind index for lookup and a field-encrypted copy for display, and nothing
// returned from this module ever contains a plaintext number.
import { prisma } from '../lib/prisma';
import { createBlindIndex, encryptPii, decryptPii } from '../lib/crypto';
import { normalizePhone, getMaskedPhone } from './phone';
import { sendSmsNotification } from './sms';
import { assertWithinRateLimit } from '../lib/rate-limit';
import { publish } from '../lib/events';

// 1600 characters is ten GSM-7 segments, the practical ceiling before carriers
// split a message and start billing it as many.
export const SMS_MAX_BODY = 1600;

// Outbound SMS is metered, so volume is capped per account. Two windows: a burst
// guard and a daily budget.
const SEND_LIMIT_HOURLY = 30;
const SEND_LIMIT_DAILY = 200;

export function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.FORCE_DEV_MODE === 'true';
}

function preview(body: string, direction: 'INBOUND' | 'OUTBOUND'): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const clipped = flat.length > 120 ? flat.slice(0, 117) + '…' : flat;
  return (direction === 'OUTBOUND' ? 'You: ' : '') + clipped;
}

function shapeMessage(m: any) {
  return {
    id: m.id,
    threadId: m.threadId,
    direction: m.direction,
    body: m.body,
    status: m.status,
    error: m.error,
    providerSid: m.providerSid,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
  };
}

function shapeThread(t: any, messageCount?: number) {
  return {
    id: t.id,
    peer: getMaskedPhone({ e164Encrypted: t.peerEncrypted }),
    label: t.label,
    isSelfNumber: !!t.peerBindingId,
    lastMessageAt: t.lastMessageAt,
    lastPreview: t.lastPreview,
    unreadCount: t.unreadCount,
    archived: !!t.archivedAt,
    messageCount,
  };
}

async function touchThread(
  threadId: string,
  update: { lastPreview: string; unreadDelta: number }
): Promise<void> {
  const thread = await prisma.smsThread.findUnique({ where: { id: threadId } });
  if (!thread) return;
  await prisma.smsThread.update({
    where: { id: threadId },
    data: {
      lastMessageAt: new Date(),
      lastPreview: update.lastPreview,
      unreadCount: Math.max(0, thread.unreadCount + update.unreadDelta),
    },
  });
}

// Single funnel for "a message just landed": refresh the denormalised thread
// fields, then push both the message and the updated thread to the browser so
// an open conversation and the thread list update from one event.
async function afterMessageChange(
  accountId: string,
  threadId: string,
  message: any,
  lastPreview: string,
  unreadDelta: number
) {
  await touchThread(threadId, { lastPreview, unreadDelta });
  const refreshed = await prisma.smsThread.findUnique({ where: { id: threadId } });
  publish(accountId, 'sms', { threadId, message: shapeMessage(message) });
  if (refreshed) publish(accountId, 'thread', shapeThread(refreshed));
}

/* ============================================================
   threads
   ============================================================ */

export async function listThreads(
  accountId: string,
  options: { includeArchived?: boolean; take?: number } = {}
) {
  const { includeArchived = false, take = 100 } = options;
  const threads = await prisma.smsThread.findMany({
    where: { accountId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { lastMessageAt: 'desc' },
    take,
    include: { _count: { select: { messages: true } } },
  });
  return threads.map((t) => shapeThread(t, t._count.messages));
}

export async function getThread(accountId: string, threadId: string) {
  const thread = await prisma.smsThread.findFirst({ where: { id: threadId, accountId } });
  if (!thread) throw new Error('THREAD_NOT_FOUND');
  return thread;
}

export async function getOrCreateThread(accountId: string, peerPhone: string) {
  const parsed = normalizePhone(peerPhone);
  if (!parsed) throw new Error('INVALID_PHONE_NUMBER');
  const e164 = parsed.e164;
  const peerHash = createBlindIndex(e164);

  const existing = await prisma.smsThread.findUnique({
    where: { accountId_peerHash: { accountId, peerHash } },
  });
  if (existing) return existing;

  // Texting one of your own verified numbers is a legitimate thing to do (it
  // shows up as a self-thread), so link the binding when the peer is ours.
  const ownBinding = await prisma.phoneBinding.findFirst({
    where: { e164Hash: peerHash, accountId, status: 'ACTIVE' },
    select: { id: true },
  });

  try {
    return await prisma.smsThread.create({
      data: {
        accountId,
        peerHash,
        peerEncrypted: encryptPii(e164),
        peerBindingId: ownBinding?.id ?? null,
      },
    });
  } catch (error: any) {
    // Two concurrent first-sends to the same peer race on the unique index.
    // The loser re-reads the winner's row instead of failing the send.
    if (error?.code === 'P2002') {
      const raced = await prisma.smsThread.findUnique({
        where: { accountId_peerHash: { accountId, peerHash } },
      });
      if (raced) return raced;
    }
    throw error;
  }
}

export async function updateThread(
  accountId: string,
  threadId: string,
  update: { label?: string | null; archived?: boolean }
) {
  const thread = await getThread(accountId, threadId);
  const updated = await prisma.smsThread.update({
    where: { id: thread.id },
    data: {
      ...(update.label !== undefined ? { label: update.label } : {}),
      ...(update.archived !== undefined
        ? { archivedAt: update.archived ? new Date() : null }
        : {}),
    },
  });
  return shapeThread(updated);
}

export async function deleteThread(accountId: string, threadId: string) {
  const thread = await getThread(accountId, threadId);
  // SmsMessage cascades, so the conversation goes with the thread row.
  await prisma.smsThread.delete({ where: { id: thread.id } });
  publish(accountId, 'thread-deleted', { threadId: thread.id });
}

export async function markThreadRead(accountId: string, threadId: string) {
  const thread = await getThread(accountId, threadId);
  // updateMany first so its row count - the number of messages actually
  // cleared - is the one that comes back from the transaction.
  const [cleared, updatedThread] = await prisma.$transaction([
    prisma.smsMessage.updateMany({
      where: { threadId: thread.id, direction: 'INBOUND', readAt: null },
      data: { readAt: new Date() },
    }),
    prisma.smsThread.update({ where: { id: thread.id }, data: { unreadCount: 0 } }),
  ]);
  publish(accountId, 'thread', shapeThread(updatedThread));
  return cleared.count;
}

/* ============================================================
   messages
   ============================================================ */

export async function listMessages(
  accountId: string,
  threadId: string,
  options: { before?: string; limit?: number } = {}
) {
  const { before, limit = 50 } = options;
  const thread = await getThread(accountId, threadId);

  const rows = await prisma.smsMessage.findMany({
    where: {
      threadId: thread.id,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });

  // Returned oldest-first so the client can render straight into the DOM.
  return {
    thread: shapeThread(thread),
    messages: rows.reverse().map(shapeMessage),
    hasMore: rows.length === Math.min(Math.max(limit, 1), 100),
  };
}

export async function sendText(accountId: string, peerPhone: string, rawBody: string) {
  const body = (rawBody || '').trim();
  if (!body) throw new Error('MESSAGE_EMPTY');
  if (body.length > SMS_MAX_BODY) throw new Error('MESSAGE_TOO_LONG');

  await assertWithinRateLimit(`sms:send:${accountId}:1h`, SEND_LIMIT_HOURLY, 3600);
  await assertWithinRateLimit(`sms:send:${accountId}:24h`, SEND_LIMIT_DAILY, 86400);

  const thread = await getOrCreateThread(accountId, peerPhone);
  const peerE164 = decryptPii(thread.peerEncrypted);

  // Recorded before the send so a webhook that arrives mid-flight has a row to
  // update, and so a crash still leaves an auditable QUEUED message.
  const queued = await prisma.smsMessage.create({
    data: { threadId: thread.id, direction: 'OUTBOUND', body, status: 'QUEUED' },
  });

  let saved;
  try {
    const result = await sendSmsNotification(peerE164, body);
    const sid = typeof result?.sid === 'string' && result.sid.startsWith('SM') ? result.sid : null;
    saved = await prisma.smsMessage.update({
      where: { id: queued.id },
      data: {
        providerSid: sid,
        status: result?.status === 'failed' ? 'FAILED' : 'SENT',
        sentAt: new Date(),
        failedAt: result?.status === 'failed' ? new Date() : null,
        error: result?.status === 'failed' ? 'SEND_FAILED' : null,
      },
    });
  } catch (error: any) {
    saved = await prisma.smsMessage.update({
      where: { id: queued.id },
      data: { status: 'FAILED', failedAt: new Date(), error: 'SEND_FAILED' },
    });
  }

  await afterMessageChange(
    accountId,
    thread.id,
    saved,
    preview(body, 'OUTBOUND'),
    0
  );

  if (saved.status === 'FAILED') throw new Error('SEND_FAILED');
  return shapeMessage(saved);
}

/**
 * Send into an existing conversation.
 *
 * The client only ever sees a masked peer number, so it cannot supply the `to`
 * address for follow-up messages. The peer is decrypted server-side from the
 * thread row instead, which also keeps plaintext numbers out of the browser.
 */
export async function sendToThread(accountId: string, threadId: string, rawBody: string) {
  const thread = await getThread(accountId, threadId);
  return sendText(accountId, decryptPii(thread.peerEncrypted), rawBody);
}

export async function simulateInbound(accountId: string, threadId: string, rawBody: string) {
  if (!isDevMode()) throw new Error('DEV_MODE_ONLY');
  const body = (rawBody || '').trim();
  if (!body) throw new Error('MESSAGE_EMPTY');
  if (body.length > SMS_MAX_BODY) throw new Error('MESSAGE_TOO_LONG');

  const thread = await getThread(accountId, threadId);
  const message = await prisma.smsMessage.create({
    data: {
      threadId: thread.id,
      direction: 'INBOUND',
      body,
      status: 'DELIVERED',
      deliveredAt: new Date(),
    },
  });

  await afterMessageChange(accountId, thread.id, message, preview(body, 'INBOUND'), 1);
  return shapeMessage(message);
}

/**
 * Persist an inbound text.
 *
 * Called from the Twilio webhook, which is at-least-once: the same MessageSid
 * can arrive several times, so a providerSid that already exists is treated as
 * a replay and dropped.
 */
export async function receiveText(
  fromPhone: string,
  rawBody: string,
  providerSid?: string
): Promise<{ stored: boolean; reason?: string; count?: number }> {
  const parsed = normalizePhone(fromPhone);
  if (!parsed) return { stored: false, reason: 'INVALID_PHONE_NUMBER' };

  const body = (rawBody || '').trim();
  if (!body) return { stored: false, reason: 'EMPTY' };

  if (providerSid) {
    const seen = await prisma.smsMessage.findUnique({ where: { providerSid } });
    if (seen) return { stored: false, reason: 'DUPLICATE' };
  }

  // A sender can be a peer in more than one account's thread list, so this
  // fans out. providerSid is unique, so only the first row may claim it.
  const peerHash = createBlindIndex(parsed.e164);
  const threads = await prisma.smsThread.findMany({
    where: { peerHash },
    select: { id: true, accountId: true },
  });
  if (!threads.length) return { stored: false, reason: 'NO_THREAD' };

  let first = true;
  for (const t of threads) {
    const message = await prisma.smsMessage.create({
      data: {
        threadId: t.id,
        direction: 'INBOUND',
        body,
        status: 'DELIVERED',
        deliveredAt: new Date(),
        providerSid: first && providerSid ? providerSid : null,
      },
    });
    first = false;
    await afterMessageChange(t.accountId, t.id, message, preview(body, 'INBOUND'), 1);
  }

  return { stored: true, count: threads.length };
}

/** Map a carrier delivery status onto our own enum. */
export function smsStatusFromCarrier(status: string | undefined): 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' {
  switch ((status || '').toLowerCase()) {
    case 'sent': return 'SENT';
    case 'delivered': return 'DELIVERED';
    case 'read': return 'READ';
    case 'failed':
    case 'undelivered': return 'FAILED';
    default: return 'QUEUED';
  }
}

/** Apply a carrier delivery receipt to a stored outbound message. */
export async function applyDeliveryStatus(
  providerSid: string,
  status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
  error?: string
) {
  const existing = await prisma.smsMessage.findUnique({
    where: { providerSid },
    include: { thread: { select: { id: true, accountId: true } } },
  });
  if (!existing) return false;

  const now = new Date();
  const updated = await prisma.smsMessage.update({
    where: { providerSid },
    data: {
      status,
      error: status === 'FAILED' ? error ?? 'DELIVERY_FAILED' : null,
      sentAt: existing.sentAt ?? (status === 'SENT' ? now : null),
      deliveredAt: status === 'DELIVERED' || status === 'READ' ? now : existing.deliveredAt,
      readAt: status === 'READ' ? now : existing.readAt,
      failedAt: status === 'FAILED' ? now : existing.failedAt,
    },
  });

  // Push the new tick so an open conversation reflects it without a refetch.
  publish(existing.thread.accountId, 'sms', {
    threadId: existing.threadId,
    message: shapeMessage(updated),
  });
  return true;
}
