// src/services/phone.ts
import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';
import twilio from 'twilio';
import { prisma } from '../lib/prisma';
import { createBlindIndex, encryptPii, decryptPii, maskPhoneNumber } from '../lib/crypto';

export interface ParsedPhone {
  e164: string;
  country: string;
  nationalNumber: string;
  lineType: LineType;
  isValid: boolean;
  carrier?: CarrierInfo;
}

export type LineType = 'MOBILE' | 'LANDLINE' | 'VOIP' | 'UNKNOWN';

export interface CarrierInfo {
  name?: string;
  type?: LineType;
  mobileCountryCode?: string;
  mobileNetworkCode?: string;
  isPorted?: boolean;
  portedDate?: Date;
  error?: string;
}

export interface PhoneNormalizationResult {
  parsed: ParsedPhone;
  binding?: PhoneBindingData;
  isNewNumber: boolean;
  riskSignals: RiskSignal[];
}

export interface PhoneBindingData {
  id: string;
  accountId: string;
  status: string;
  roleFlags: string[]; // Now array of RoleFlag
  isPrimary: boolean;
  verifiedAt: Date | null;
  carrierSnapshot: any;
}

export interface RiskSignal {
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  description: string;
  metadata?: any;
}

/**
 * Normalize and parse phone number to E.164
 */
export function normalizePhone(raw: string, defaultCountry?: string): ParsedPhone | null {
  try {
    const phone = parsePhoneNumberFromString(raw, defaultCountry as CountryCode);
    
    if (!phone || !phone.isValid()) {
      return null;
    }
    
    const lineType = mapLineType(phone.getType());
    
    return {
      e164: phone.number,
      country: phone.country || 'UNKNOWN',
      nationalNumber: phone.nationalNumber,
      lineType,
      isValid: true,
    };
  } catch (error) {
    console.error('Phone normalization error:', error);
    return null;
  }
}

function mapLineType(type?: string): LineType {
  if (!type) return 'UNKNOWN';
  const t = type.toUpperCase();
  if (t === 'MOBILE') return 'MOBILE';
  if (t === 'FIXED_LINE' || t === 'LANDLINE') return 'LANDLINE';
  if (t === 'VOIP') return 'VOIP';
  if (t === 'PREMIUM_RATE' || t === 'SHARED_COST' || t === 'TOLL_FREE') return 'VOIP';
  return 'UNKNOWN';
}

/**
 * Perform carrier lookup using Twilio Lookup API v2
 */
export async function carrierLookup(e164: string): Promise<CarrierInfo> {
  // Twilio Lookup v2 is billed per request. Honour FORCE_DEV_MODE the same way
  // sms.ts does so development sign-ups never spend money or add ~1s of latency.
  if (process.env.FORCE_DEV_MODE === 'true') {
    return { error: 'DEV_MODE' };
  }
  
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !sid.startsWith('AC')) {
    return { error: 'TWILIO_NOT_CONFIGURED' };
  }
  
  try {
    const client = twilio(sid, token);
    
    const result = await client.lookups.v2.phoneNumbers(e164).fetch({
      fields: 'line_type_intelligence,caller_name',
    });
    
    const lineTypeIntel = result.lineTypeIntelligence;
    
    return {
      name: lineTypeIntel?.carrierName,
      type: mapTwilioLineType(lineTypeIntel?.type),
      mobileCountryCode: lineTypeIntel?.mobileCountryCode,
      mobileNetworkCode: lineTypeIntel?.mobileNetworkCode,
      isPorted: false, // Twilio type may not have this property
    };
  } catch (error: any) {
    console.error('Carrier lookup error:', error);
    return { error: error.message };
  }
}

function mapTwilioLineType(type?: string): LineType {
  if (!type) return 'UNKNOWN';
  const t = type.toLowerCase();
  if (t === 'mobile') return 'MOBILE';
  if (t === 'landline') return 'LANDLINE';
  if (t === 'voip') return 'VOIP';
  return 'UNKNOWN';
}

/**
 * Check if number is in disposable/VOIP ranges (heuristic)
 */
export function checkDisposableVoip(lineType: LineType, carrier?: CarrierInfo): RiskSignal[] {
  const signals: RiskSignal[] = [];
  
  if (lineType === 'VOIP') {
    signals.push({
      type: 'VOIP_DISPOSABLE',
      severity: 'HIGH',
      description: 'Voice over IP / virtual number detected',
      metadata: { lineType, carrier: carrier?.name },
    });
  }
  
  if (carrier?.name) {
    const disposableCarriers = [
      'textnow', 'textfree', 'google voice', 'burner', 'hushed',
      'sideline', 'grasshopper', 'line2', 'talkatone', 'textme',
      'freetone', 'textplus', 'pinger', 'ding tone', '2ndline',
    ];
    
    const carrierLower = carrier.name.toLowerCase();
    if (disposableCarriers.some(d => carrierLower.includes(d))) {
      signals.push({
        type: 'DISPOSABLE_CARRIER',
        severity: 'HIGH',
        description: 'Known disposable/temporary number carrier',
        metadata: { carrier: carrier.name },
      });
    }
  }
  
  return signals;
}

/**
 * Create or get phone binding for an account
 */
export async function createPhoneBinding(
  accountId: string,
  parsed: ParsedPhone,
  carrier: CarrierInfo,
  roleFlags: string[] = ['LOGIN', 'RECOVERY', 'NOTIFICATIONS'],
  isPrimary: boolean = false
) {
  const e164Hash = createBlindIndex(parsed.e164);
  const e164Encrypted = encryptPii(parsed.e164);
  
  // Check if number already bound to another active account
  const existingBinding = await prisma.phoneBinding.findUnique({
    where: { e164Hash },
    include: { account: true },
  });
  
  if (existingBinding) {
    if (existingBinding.status === 'ACTIVE' && existingBinding.accountId !== accountId) {
      throw new Error('NUMBER_ALREADY_BOUND');
    }
    if (existingBinding.status === 'PENDING' && existingBinding.accountId !== accountId) {
      // Pending claim by another account - check expiry
      const age = Date.now() - existingBinding.createdAt.getTime();
      if (age < 10 * 60 * 1000) { // 10 minutes
        throw new Error('NUMBER_PENDING_ANOTHER_ACCOUNT');
      }
      // Expired pending claim - can proceed
    }
  }
  
  // If this is primary, unset other primary bindings for this account
  if (isPrimary) {
    await prisma.phoneBinding.updateMany({
      where: { accountId, isPrimary: true },
      data: { isPrimary: false },
    });
  }
  
  const binding = await prisma.phoneBinding.create({
    data: {
      accountId,
      e164Hash,
      e164Encrypted,
      country: parsed.country,
      carrier: carrier.name,
      lineType: parsed.lineType,
      portStatus: carrier.isPorted ? 'ported' : 'none',
      status: 'PENDING',
      roleFlags: roleFlags as any, // Cast to RoleFlag[]
      isPrimary,
      carrierSnapshot: carrier as any,
    },
  });
  
  return binding;
}

/**
 * Verify phone binding (mark as active after OTP verification)
 */
export async function verifyPhoneBinding(bindingId: string, carrierSnapshot?: any) {
  const binding = await prisma.phoneBinding.update({
    where: { id: bindingId },
    data: {
      status: 'ACTIVE',
      verifiedAt: new Date(),
      lastVerifiedAt: new Date(),
      carrierSnapshot: carrierSnapshot || undefined,
    },
  });
  
  // Update account lastActiveAt
  await prisma.account.update({
    where: { id: binding.accountId },
    data: { lastActiveAt: new Date() },
  });
  
  return binding;
}

/**
 * Get decrypted phone number for binding (internal use only)
 */
export function getDecryptedPhone(binding: { e164Encrypted: string }): string {
  return decryptPii(binding.e164Encrypted);
}

/**
 * Get masked phone for display
 */
export function getMaskedPhone(binding: { e164Encrypted: string }): string {
  const e164 = decryptPii(binding.e164Encrypted);
  return maskPhoneNumber(e164);
}

/**
 * Check if account has reached max phone bindings (3)
 */
export async function canAddPhoneBinding(accountId: string): Promise<boolean> {
  const count = await prisma.phoneBinding.count({
    where: { accountId, status: { in: ['ACTIVE', 'PENDING'] } },
  });
  return count < 3;
}

/**
 * Detect SIM swap signals
 */
export async function detectSimSwapSignals(
  phoneBindingId: string,
  deviceId?: string,
  ipAddress?: string
): Promise<{ riskScore: number; signals: RiskSignal[] }> {
  const binding = await prisma.phoneBinding.findUnique({
    where: { id: phoneBindingId },
  });
  
  if (!binding) return { riskScore: 0, signals: [] };
  
  const signals: RiskSignal[] = [];
  let riskScore = 0;
  
  // 1. Carrier change since last verification
  // carrierLookup() returns { name, type, ... } - read `name`, not `carrierName`.
  if (binding.carrierSnapshot && binding.carrier) {
    const snapshot = binding.carrierSnapshot as any;
    const oldCarrier = snapshot.name ?? snapshot.carrierName;
    if (oldCarrier && oldCarrier !== binding.carrier) {
      signals.push({
        type: 'CARRIER_CHANGE',
        severity: 'HIGH',
        description: 'Carrier changed since last verification - possible port-out fraud',
        metadata: { oldCarrier, newCarrier: binding.carrier },
      });
      riskScore += 40;
    }
  }
  
  // 2. Recent port detected
  if (binding.portStatus === 'ported') {
    signals.push({
      type: 'RECENT_PORT',
      severity: 'MEDIUM',
      description: 'Number recently ported',
      metadata: { portStatus: binding.portStatus },
    });
    riskScore += 25;
  }
  
  // 3. New device requesting OTP
  if (deviceId) {
    const recentChallenges = await prisma.otpChallenge.findMany({
      where: {
        phoneBindingId,
        deviceId: { not: deviceId },
        createdAt: { gte: new Date(Date.now() - 72 * 60 * 60 * 1000) }, // 72 hours
      },
      select: { deviceId: true },
      distinct: ['deviceId'],
    });
    
    if (recentChallenges.length > 0) {
      signals.push({
        type: 'NEW_DEVICE_OTP',
        severity: 'MEDIUM',
        description: 'OTP requested from new device within 72 hours',
        metadata: { deviceCount: recentChallenges.length },
      });
      riskScore += 20;
    }
  }
  
  // 4. Multiple accounts on same device.
  // Device.id is a server-generated unique UUID, so a findMany on it can never
  // return more than one row - that check was unreachable. The challenge's
  // deviceId is a client fingerprint shared across accounts, so count distinct
  // accounts that have challenged with it recently.
  if (deviceId) {
    const recent = await prisma.otpChallenge.findMany({
      where: {
        deviceId,
        phoneBindingId: { not: null },
        createdAt: { gte: new Date(Date.now() - 72 * 60 * 60 * 1000) }, // 72 hours
      },
      select: { phoneBinding: { select: { accountId: true } } },
    });
    
    const accountIds = new Set(
      recent.map((r) => r.phoneBinding?.accountId).filter(Boolean)
    );
    
    if (accountIds.size > 1) {
      signals.push({
        type: 'MULTIPLE_ACCOUNTS_DEVICE',
        severity: 'HIGH',
        description: 'Device associated with multiple accounts',
        metadata: { accountCount: accountIds.size },
      });
      riskScore += 30;
    }
  }
  
  // 5. VOIP/Disposable number
  const disposableSignals = checkDisposableVoip(binding.lineType, { name: binding.carrier ?? undefined });
  signals.push(...disposableSignals);
  riskScore += disposableSignals.reduce((sum, s) => sum + (s.severity === 'HIGH' ? 20 : 10), 0);
  
  // Store signals for audit
  for (const signal of signals) {
    await prisma.simSwapSignal.create({
      data: {
        phoneBindingId,
        source: 'HEURISTIC',
        signal: signal.type as any,
        confidence: signal.severity === 'HIGH' ? 80 : 50,
        details: signal.metadata,
      },
    });
  }
  
  // Update binding risk score
  await prisma.phoneBinding.update({
    where: { id: phoneBindingId },
    data: { simSwapRiskScore: Math.min(100, riskScore), simSwapCheckedAt: new Date() },
  });
  
  return { riskScore: Math.min(100, riskScore), signals };
}

/**
 * Check if SIM swap detected within window (default 72 hours)
 */
export async function isSimSwapRecent(phoneBindingId: string, windowHours: number = 72): Promise<boolean> {
  const signals = await prisma.simSwapSignal.findMany({
    where: {
      phoneBindingId,
      signal: 'SIM_SWAP_DETECTED',
      detectedAt: { gte: new Date(Date.now() - windowHours * 60 * 60 * 1000) },
    },
  });
  return signals.length > 0;
}

/**
 * Get primary phone for account
 */
export async function getPrimaryPhone(accountId: string): Promise<string | null> {
  const binding = await prisma.phoneBinding.findFirst({
    where: { accountId, isPrimary: true, status: 'ACTIVE' },
  });
  
  if (!binding) return null;
  return getDecryptedPhone(binding);
}

/**
 * Send SMS notification
 */
export async function sendSmsNotification(phone: string, body: string) {
  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
  
  return client.messages.create({
    to: phone,
    from: process.env.TWILIO_PHONE_NUMBER!,
    body,
    statusCallback: `${process.env.WEBHOOK_BASE_URL}/webhooks/sms/status`,
  });
}