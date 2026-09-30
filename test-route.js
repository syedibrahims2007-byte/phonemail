const express = require('express');
const { createChallenge } = require('./src/services/otp');
const { normalizePhone } = require('./src/services/phone');

const app = express();
app.use(express.json());

app.post('/test', async (req, res) => {
  try {
    const { phone, channel = 'SMS' } = req.body;
    const parsed = normalizePhone(phone);
    if (!parsed) return res.status(400).json({ error: 'INVALID_PHONE_NUMBER' });
    
    const challenge = await createChallenge(parsed.e164, channel, { purpose: 'LOGIN' });
    res.json({ challengeId: challenge.challengeId, channel: challenge.channel });
  } catch (e) {
    console.error('Route error:', e);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: e.message });
  }
});

app.listen(3001, () => console.log('Test server on 3001'));