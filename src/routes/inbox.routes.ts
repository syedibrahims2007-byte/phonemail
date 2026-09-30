import { Router } from 'express';
import { authMiddleware } from './auth.routes';
import { 
  createInboxMessage, 
  getInboxMessages, 
  markMessageRead, 
  acknowledgeLegalNotice,
  archiveMessage,
  deleteMessage,
  getUnreadCount,
} from '../services/inbox';
import { prisma } from '../lib/prisma';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// ============================================================
// INBOX ENDPOINTS
// ============================================================

// Get inbox messages
router.get('/', async (req: any, res) => {
  try {
    const { status, category, limit = 50, offset = 0 } = req.query;
    
    const result = await getInboxMessages(req.account.id, {
      status: status as any,
      category: category as any,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
    
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Get unread count
router.get('/unread-count', async (req: any, res) => {
  try {
    const count = await getUnreadCount(req.account.id);
    res.json({ count });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Get single message
router.get('/:id', async (req: any, res) => {
  try {
    const message = await prisma.inboxMessage.findFirst({
      where: { id: req.params.id, accountId: req.account.id },
    });
    
    if (!message) return res.status(404).json({ error: 'MESSAGE_NOT_FOUND' });
    
    res.json({ message });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Mark as read
router.patch('/:id/read', async (req: any, res) => {
  try {
    const message = await markMessageRead(req.account.id, req.params.id);
    res.json({ message });
  } catch (error: any) {
    if (error.message === 'MESSAGE_NOT_FOUND') return res.status(404).json({ error: 'MESSAGE_NOT_FOUND' });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Acknowledge legal notice
router.post('/:id/acknowledge', async (req: any, res) => {
  try {
    const message = await acknowledgeLegalNotice(req.account.id, req.params.id);
    res.json({ message });
  } catch (error: any) {
    if (error.message === 'LEGAL_NOTICE_NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Archive message
router.patch('/:id/archive', async (req: any, res) => {
  try {
    const message = await archiveMessage(req.account.id, req.params.id);
    res.json({ message });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Delete message
router.delete('/:id', async (req: any, res) => {
  try {
    await deleteMessage(req.account.id, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Bulk operations
router.post('/bulk', async (req: any, res) => {
  try {
    const { action, messageIds } = req.body;
    
    if (!Array.isArray(messageIds) || !messageIds.length) {
      return res.status(400).json({ error: 'INVALID_MESSAGE_IDS' });
    }
    
    let result;
    switch (action) {
      case 'read':
        result = await prisma.inboxMessage.updateMany({
          where: { id: { in: messageIds }, accountId: req.account.id },
          data: { status: 'READ', readAt: new Date() },
        });
        break;
      case 'archive':
        result = await prisma.inboxMessage.updateMany({
          where: { id: { in: messageIds }, accountId: req.account.id },
          data: { status: 'ARCHIVED' },
        });
        break;
      case 'delete':
        result = await prisma.inboxMessage.updateMany({
          where: { id: { in: messageIds }, accountId: req.account.id },
          data: { status: 'DELETED' },
        });
        break;
      default:
        return res.status(400).json({ error: 'INVALID_ACTION' });
    }
    
    res.json({ success: true, count: result.count });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Get message categories summary
router.get('/summary/categories', async (req: any, res) => {
  try {
    const summary = await prisma.inboxMessage.groupBy({
      by: ['category', 'status'],
      // Matches the unfiltered list: soft-deleted rows are not a category
      // the user can filter to anything.
      where: { accountId: req.account.id, status: { not: 'DELETED' } },
      _count: { id: true },
    });
    
    res.json({ summary });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Admin: Send test message (for development)
//
// Values are validated against the Prisma enums first. Without this an invalid
// category reached prisma.inboxMessage.create and surfaced as a bare 500 with
// nothing logged, which is indistinguishable from a real outage.
const MESSAGE_TYPES = ['SECURITY_ALERT', 'TRANSACTIONAL', 'RECEIPT_INVOICE', 'MARKETING', 'LEGAL_NOTICE', 'SYSTEM'];
const MESSAGE_CATEGORIES = ['AUTH', 'SECURITY', 'TRANSACTION', 'BILLING', 'MARKETING', 'LEGAL', 'SYSTEM'];
const MESSAGE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];

router.post('/test', async (req: any, res) => {
  try {
    const { type, category, subject, body, priority } = req.body;
    
    if (type && !MESSAGE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'INVALID_TYPE', allowed: MESSAGE_TYPES });
    }
    if (category && !MESSAGE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'INVALID_CATEGORY', allowed: MESSAGE_CATEGORIES });
    }
    if (priority && !MESSAGE_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: 'INVALID_PRIORITY', allowed: MESSAGE_PRIORITIES });
    }
    
    const message = await createInboxMessage({
      accountId: req.account.id,
      type: type || 'SYSTEM',
      category: category || 'SYSTEM',
      subject: subject || 'Test Message',
      body: body || 'This is a test message from PhoneMail',
      priority: priority || 'NORMAL',
    });
    
    // createInboxMessage returns null when consent blocks the message.
    if (!message) return res.status(400).json({ error: 'BLOCKED_NO_CONSENT' });
    
    res.json({ message });
  } catch (error: any) {
    console.error('Create test message failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;