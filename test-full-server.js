process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('UNHANDLED:', reason); process.exit(1); });

require('dotenv/config');
const express = require('express');

console.log('1. Loading worker functions');
const { scheduleRecurringJobs, shutdownWorkers } = require('./src/queues/worker');

console.log('Loading routes');
const authRoutes = require('./src/routes/auth.routes').default;
const phoneRoutes = require('./src/routes/phones.routes').default;
const inboxRoutes = require('./src/routes/inbox.routes').default;
const recoveryRoutes = require('./src/routes/recovery.routes').default;
const passkeyRoutes = require('./src/routes/passkey.routes').default;
const webhookRoutes = require('./src/routes/webhook.routes').default;

console.log('Creating app');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/auth', authRoutes);
app.use('/phones', phoneRoutes);
app.use('/inbox', inboxRoutes);
app.use('/recovery', recoveryRoutes);
app.use('/passkeys', require('./src/routes/passkey.routes').default);
app.use('/', require('./src/routes/webhook.routes').default);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

console.log('Starting server');
const server = app.listen(3000, () => console.log('Server running on 3000'));