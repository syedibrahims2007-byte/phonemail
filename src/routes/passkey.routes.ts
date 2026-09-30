import { Router } from 'express';
import { authMiddleware } from './auth.routes';
import { 
  startPasskeyRegistration, 
  completePasskeyRegistration, 
  startPasskeyAuthentication, 
  completePasskeyAuthentication,
  listPasskeys,
  revokePasskey,
} from '../services/passkey';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// ============================================================
// PASSKEY ENDPOINTS
// ============================================================

// List passkeys
router.get('/', async (req: any, res) => {
  try {
    const passkeys = await listPasskeys(req.account.id);
    res.json({ passkeys });
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Start passkey registration
router.post('/register/start', async (req: any, res) => {
  try {
    const { deviceName } = req.body;
    
    const result = await startPasskeyRegistration(req.account.id, deviceName);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Complete passkey registration
router.post('/register/complete', async (req: any, res) => {
  try {
    const { credential, deviceName } = req.body;
    
    if (!credential) return res.status(400).json({ error: 'CREDENTIAL_REQUIRED' });
    
    const result = await completePasskeyRegistration(req.account.id, credential, deviceName);
    res.json(result);
  } catch (error: any) {
    if (error.message === 'CHALLENGE_EXPIRED') return res.status(400).json({ error: 'CHALLENGE_EXPIRED' });
    if (error.message === 'REGISTRATION_VERIFICATION_FAILED') return res.status(400).json({ error: 'VERIFICATION_FAILED' });
    console.error('Passkey registration error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Start passkey authentication (for step-up or primary auth)
router.post('/authenticate/start', async (req: any, res) => {
  try {
    // Can be called with or without account context
    const accountId = req.account?.id;
    
    const result = await startPasskeyAuthentication(accountId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Complete passkey authentication
router.post('/authenticate/complete', async (req: any, res) => {
  try {
    const { credential } = req.body;
    
    if (!credential) return res.status(400).json({ error: 'CREDENTIAL_REQUIRED' });
    
    const result = await completePasskeyAuthentication(credential, req.account?.id);
    res.json(result);
  } catch (error: any) {
    if (error.message === 'CHALLENGE_EXPIRED') return res.status(400).json({ error: 'CHALLENGE_EXPIRED' });
    if (error.message === 'CREDENTIAL_NOT_FOUND') return res.status(404).json({ error: 'CREDENTIAL_NOT_FOUND' });
    if (error.message === 'AUTHENTICATION_VERIFICATION_FAILED') return res.status(400).json({ error: 'VERIFICATION_FAILED' });
    console.error('Passkey authentication error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Revoke passkey
router.delete('/:credentialId', async (req: any, res) => {
  try {
    await revokePasskey(req.account.id, req.params.credentialId);
    res.json({ success: true });
  } catch (error: any) {
    if (error.message === 'PASSKEY_NOT_FOUND') return res.status(404).json({ error: 'NOT_FOUND' });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;