import { Router } from 'express';
import { authMiddleware } from './auth.routes';
import { 
  initiateRecovery, 
  approveRecovery, 
  cancelRecovery, 
  verifyRecoveryCode,
  getRecoveryStatus,
  addTrustedContact,
  confirmTrustedContact,
} from '../services/recovery';
import { prisma } from '../lib/prisma';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// ============================================================
// RECOVERY ENDPOINTS
// ============================================================

// Initiate recovery
router.post('/initiate', async (req: any, res) => {
  try {
    const { tier, trigger, deviceId, metadata } = req.body;
    
    const validTiers = ['SAME_NUMBER_OTP', 'TRUSTED_DEVICE_APPROVAL', 'RECOVERY_CODE', 'SECONDARY_NUMBER', 'TRUSTED_CONTACT', 'IDENTITY_VERIFICATION'];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ error: 'INVALID_RECOVERY_TIER' });
    }
    
    const result = await initiateRecovery({
      accountId: req.account.id,
      tier: tier as any,
      trigger: trigger || 'USER_INITIATED',
      deviceId: deviceId || req.deviceId,
      ipAddress: req.ip,
      metadata,
    });
    
    res.json(result);
  } catch (error: any) {
    if (error.message === 'RECOVERY_ALREADY_IN_PROGRESS') {
      return res.status(409).json({ error: 'RECOVERY_IN_PROGRESS' });
    }
    if (error.message === 'NO_TRUSTED_DEVICES') {
      return res.status(400).json({ error: 'NO_TRUSTED_DEVICES' });
    }
    if (error.message === 'NO_SECONDARY_NUMBER') {
      return res.status(400).json({ error: 'NO_SECONDARY_NUMBER' });
    }
    if (error.message === 'INSUFFICIENT_TRUSTED_CONTACTS') {
      return res.status(400).json({ error: 'INSUFFICIENT_TRUSTED_CONTACTS' });
    }
    console.error('Recovery initiate error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Get recovery status
router.get('/status', async (req: any, res) => {
  try {
    const status = await getRecoveryStatus(req.account.id);
    res.json({ recovery: status });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Approve recovery from trusted device
router.post('/:attemptId/approve', async (req: any, res) => {
  try {
    const { approved = true } = req.body;
    
    const result = await approveRecovery(req.params.attemptId, req.deviceId!, approved);
    res.json(result);
  } catch (error: any) {
    if (error.message === 'RECOVERY_ATTEMPT_NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    if (error.message === 'RECOVERY_NOT_PENDING') return res.status(400).json({ error: 'NOT_PENDING' });
    if (error.message === 'UNAUTHORIZED_DEVICE') return res.status(403).json({ error: 'UNAUTHORIZED_DEVICE' });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Cancel recovery
router.post('/:attemptId/cancel', async (req: any, res) => {
  try {
    await cancelRecovery(req.params.attemptId, req.deviceId || 'user');
    res.json({ success: true });
  } catch (error: any) {
    if (error.message === 'RECOVERY_ATTEMPT_NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    if (error.message === 'RECOVERY_ALREADY_FINISHED') return res.status(400).json({ error: 'ALREADY_FINISHED' });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Verify recovery code
router.post('/code/verify', async (req: any, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'CODE_REQUIRED' });
    
    const valid = await verifyRecoveryCode(req.account.id, code);
    res.json({ valid });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ============================================================
// TRUSTED CONTACTS
// ============================================================

// List trusted contacts
router.get('/contacts', async (req: any, res) => {
  try {
    const contacts = await prisma.trustedContact.findMany({
      where: { accountId: req.account.id },
      select: {
        id: true,
        contactAccountId: true,
        contactName: true,
        contactHandle: true,
        addedAt: true,
        confirmedAt: true,
        threshold: true,
      },
    });
    
    res.json({ contacts });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Add trusted contact
router.post('/contacts', async (req: any, res) => {
  try {
    const { contactHandle } = req.body;
    if (!contactHandle) return res.status(400).json({ error: 'CONTACT_HANDLE_REQUIRED' });
    
    const contact = await addTrustedContact(req.account.id, contactHandle);
    res.status(201).json({ contact });
  } catch (error: any) {
    if (error.message === 'CONTACT_NOT_FOUND') return res.status(404).json({ error: 'CONTACT_NOT_FOUND' });
    if (error.message === 'CANNOT_ADD_SELF') return res.status(400).json({ error: 'CANNOT_ADD_SELF' });
    if (error.message === 'CONTACT_ALREADY_TRUSTED') return res.status(409).json({ error: 'ALREADY_TRUSTED' });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Confirm trusted contact (contact accepts request)
router.post('/contacts/:contactId/confirm', async (req: any, res) => {
  try {
    const contact = await confirmTrustedContact(req.params.contactId, req.account.id);
    res.json({ contact });
  } catch (error: any) {
    if (error.message === 'CONTACT_REQUEST_NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Remove trusted contact
router.delete('/contacts/:contactId', async (req: any, res) => {
  try {
    await prisma.trustedContact.delete({
      where: { id: req.params.contactId, accountId: req.account.id },
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;