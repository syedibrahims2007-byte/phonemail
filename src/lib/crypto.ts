import crypto from 'crypto';

// Field-level encryption for PII (phone numbers) using envelope encryption
// Keys managed in KMS/HSM in production, here we use env-based master key

const MASTER_KEY = process.env.PII_MASTER_KEY || process.env.JWT_SECRET!;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

// Derive encryption key from master key using PBKDF2
function deriveKey(salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(MASTER_KEY, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt a plaintext string (e.g., E.164 phone number)
 * Returns base64 encoded: salt:iv:ciphertext:tag
 */
export function encryptPii(plaintext: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(salt);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  return Buffer.concat([salt, iv, ciphertext, tag]).toString('base64');
}

/**
 * Decrypt a PII value encrypted with encryptPii
 */
export function decryptPii(encrypted: string): string {
  const buffer = Buffer.from(encrypted, 'base64');
  
  const salt = buffer.subarray(0, SALT_LENGTH);
  const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = buffer.subarray(buffer.length - TAG_LENGTH);
  const ciphertext = buffer.subarray(SALT_LENGTH + IV_LENGTH, buffer.length - TAG_LENGTH);
  
  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Create a blind index (HMAC) for lookups without decrypting
 * Used for uniqueness checks and phone number lookups
 */
const BLIND_INDEX_KEY = process.env.BLIND_INDEX_KEY || crypto.createHash('sha256').update(MASTER_KEY + 'blind').digest();

export function createBlindIndex(value: string): string {
  return crypto.createHmac('sha256', BLIND_INDEX_KEY)
    .update(value.toLowerCase().trim())
    .digest('hex');
}

/**
 * Mask phone number for display: +91 ••••• ••321
 */
export function maskPhoneNumber(e164: string): string {
  // Parse country code and national number
  const match = e164.match(/^\+(\d{1,3})(\d+)$/);
  if (!match) return '••••••••••';
  
  const countryCode = match[1];
  const nationalNumber = match[2];
  
  if (nationalNumber.length <= 4) {
    return `+${countryCode} ••••••••`;
  }
  
  const masked = '•'.repeat(nationalNumber.length - 4) + nationalNumber.slice(-4);
  // Group in chunks of 3-4 for readability
  const groups = masked.match(/.{1,4}/g) || [masked];
  return `+${countryCode} ${groups.join(' ')}`;
}

/**
 * Generate secure random tokens
 */
export function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate numeric OTP (6 digits from CSPRNG)
 */
export function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Hash OTP with challenge ID for storage
 */
export function hashOtp(otp: string, challengeId: string, secret: string): string {
  return crypto.createHmac('sha256', secret)
    .update(`${challengeId}:${otp}`)
    .digest('hex');
}

/**
 * Constant-time string comparison
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}