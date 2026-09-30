process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('UNHANDLED:', reason); process.exit(1); });

const express = require('express');
const app = express();
app.use(express.json());

const { createChallenge } = require('./src/services/otp');
const { normalizePhone } = require('./src/services/phone');

app.post('/test', async (req, res) => {
  try {
    const { phone, channel = 'SMS' } = req.body;
    const parsed = normalizePhone(phone);
    if (!parsed) return res.status(400).json({ error: 'INVALID_PHONE_NUMBER' });
    const challenge = await createChallenge(parsed.e164, channel, { purpose: 'LOGIN' });
    res.json({ challengeId: challenge.challengeId, channel: challenge.channel });
  } catch (e) {
    console.error('Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(3001, () => console.log('Test server on 3001'));