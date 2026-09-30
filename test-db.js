const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

prisma.$connect()
  .then(() => console.log('DB connected'))
  .catch(e => console.error('DB error:', e))
  .finally(() => setTimeout(() => process.exit(0), 1000));