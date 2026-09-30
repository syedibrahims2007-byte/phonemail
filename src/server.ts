// src/server.ts
import 'dotenv/config';
import express from 'express';
import path from 'path';
import authRoutes from './routes/auth.routes';
import phoneRoutes from './routes/phones.routes';
import inboxRoutes from './routes/inbox.routes';
import recoveryRoutes from './routes/recovery.routes';
import passkeyRoutes from './routes/passkey.routes';
import messagesRoutes from './routes/messages.routes';
import eventsRoutes from './routes/events.routes';
import webhookRoutes from './routes/webhook.routes';
import indexRoutes from './routes/index.routes';

// Worker functions - loaded lazily to avoid startup crashes
let scheduleRecurringJobs: (() => Promise<void>) | null = null;
let shutdownWorkers: (() => Promise<void>) | null = null;

async function loadWorkerModule() {
  try {
    const workerModule = await import('./queues/worker');
    scheduleRecurringJobs = workerModule.scheduleRecurringJobs;
    shutdownWorkers = workerModule.shutdownWorkers;
    console.log('Worker module loaded successfully');
  } catch (error) {
    console.warn('Worker module failed to load (workers disabled):', error);
    scheduleRecurringJobs = null;
    shutdownWorkers = null;
  }
}

const app = express();
// Increase body parser limits and add debugging
app.use(express.json({ 
  limit: '10mb',
  strict: true,
  type: 'application/json'
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Debug middleware to log raw request body
app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    console.log(`[DEBUG] ${req.method} ${req.path} - Content-Type: ${req.headers['content-type']}`);
    console.log(`[DEBUG] Content-Length: ${req.headers['content-length']}`);
    console.log(`[DEBUG] Raw body preview:`, req.body);
  }
  next();
});

// Trust proxy for accurate IP addresses
app.set('trust proxy', true);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`Slow request: ${req.method} ${req.path} - ${duration}ms`);
    }
  });
  next();
});

// Health check
app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  timestamp: new Date().toISOString(),
  version: process.env.npm_package_version || '1.0.0',
}));

// Web UI (serves /index.html at "/")
app.use(express.static(path.join(__dirname, '..', 'public')));

// Everything past this point is JSON API. A browser's cache key does not
// include the Authorization header, so without no-store a cached /auth/me from
// one account can be replayed to another account in the same browser.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// API reference page - must be registered before the 404 handler
app.use(indexRoutes);

// API Routes
app.use('/auth', authRoutes);
app.use('/phones', phoneRoutes);
app.use('/inbox', inboxRoutes);
app.use('/messages', messagesRoutes);
app.use('/recovery', recoveryRoutes);
app.use('/passkeys', passkeyRoutes);
app.use('/events', eventsRoutes);
app.use('/', webhookRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: err.message });
  }
  
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid token' });
  }
  
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

// Start server
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, async () => {
  console.log(`PhoneMail server running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Load worker module after server starts
  await loadWorkerModule();
  
  // Schedule recurring jobs if worker loaded successfully
  if (scheduleRecurringJobs) {
    try {
      await scheduleRecurringJobs();
      console.log('Recurring jobs scheduled');
    } catch (error) {
      console.warn('Failed to schedule recurring jobs:', error);
    }
  }
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down gracefully...`);
  
  server.close(async () => {
    console.log('HTTP server closed');
    
    try {
      if (shutdownWorkers) {
        await shutdownWorkers();
        console.log('Workers shut down');
      }
      
      // Close Prisma connection
      const { prisma } = await import('./lib/prisma');
      await prisma.$disconnect();
      console.log('Database disconnected');
      
      process.exit(0);
    } catch (error) {
      console.error('Shutdown error:', error);
      process.exit(1);
    }
  });
  
  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

export default app;