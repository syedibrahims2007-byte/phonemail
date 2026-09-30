// src/routes/email.routes.ts
import { Router } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/compose', upload.array('attachments', 5), async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    // TODO: wire this up to services/email.ts and services/attachments.ts once they're filled in
    res.json({ status: 'stub - not yet sending', to, subject });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;