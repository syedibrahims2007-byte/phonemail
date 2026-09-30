// src/services/push.ts
import * as admin from 'firebase-admin';
import webpush from 'web-push';
import { prisma } from '../lib/prisma';

interface DeviceToken {
  id: string;
  type: 'fcm' | 'webpush';
  token: string;
  deviceId: string;
}

// Initialize Firebase Admin
let firebaseInitialized = false;
let messaging: any = null;

function initFirebase() {
  if (firebaseInitialized) return;
  try {
    if (process.env.FCM_SERVICE_ACCOUNT_PATH) {
      const serviceAccount = require(process.env.FCM_SERVICE_ACCOUNT_PATH);
      const adminAny = admin as any;
      admin.initializeApp({ credential: adminAny.credential.cert(serviceAccount) });
    } else if (process.env.FCM_PROJECT_ID) {
      admin.initializeApp({ projectId: process.env.FCM_PROJECT_ID });
    }
    // firebase-admin v12+ uses getMessaging() from the main export
    // Use type assertion to bypass type checking issues
    const adminAny = admin as any;
    messaging = adminAny.getMessaging ? adminAny.getMessaging() : (adminAny.messaging ? adminAny.messaging() : adminAny.getMessaging());
    firebaseInitialized = true;
  } catch (e) {
    console.warn('Firebase not initialized:', e);
  }
}

// Initialize Web Push
if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  webpush.setVapidDetails(
    'mailto:admin@phonemail.app',
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
  );
}

export interface PushPayload {
  title: string;
  body: string;
  deepLink: string;
  data?: Record<string, string>;
  priority?: 'high' | 'normal';
}

/**
 * Send push notification to user's devices
 */
export async function sendPush(userId: string, payload: PushPayload): Promise<boolean> {
  const tokens = await getDeviceTokens(userId);
  if (!tokens.length) return false;
  
  let anySuccess = false;
  
  for (const t of tokens) {
    try {
      if (t.type === 'fcm') {
        await sendFcm(t.token, payload);
      } else {
        await sendWebPush(t.token, payload);
      }
      anySuccess = true;
    } catch (error: any) {
      console.error(`Push failed for ${t.type}:`, error.message);
      
      // Clean up invalid tokens
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered' ||
          error.statusCode === 410 || error.statusCode === 404) {
        await markTokenStale(t.id);
      }
    }
  }
  
  return anySuccess;
}

async function sendFcm(token: string, payload: PushPayload) {
  initFirebase();
  
  if (!messaging) throw new Error('Firebase messaging not initialized');
  
  await messaging.send({
    token,
    notification: { title: payload.title, body: payload.body },
    data: { deepLink: payload.deepLink, ...payload.data },
    android: { priority: payload.priority || 'high' },
    apns: { headers: { 'apns-priority': payload.priority === 'high' ? '10' : '5' } },
    webpush: { headers: { Urgency: payload.priority === 'high' ? 'high' : 'normal' } },
  });
}

async function sendWebPush(token: string, payload: PushPayload) {
  const pushSubscription = JSON.parse(token);
  await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
}

async function getDeviceTokens(userId: string): Promise<DeviceToken[]> {
  const devices = await prisma.device.findMany({
    where: { accountId: userId, revokedAt: null },
    select: { id: true, deviceKey: true, platform: true, pushToken: true, pushTokenType: true },
  });
  
  const tokens: DeviceToken[] = [];
  
  for (const device of devices) {
    if (device.pushToken && device.pushTokenType) {
      tokens.push({
        id: device.id,
        type: device.pushTokenType as 'fcm' | 'webpush',
        token: device.pushToken,
        deviceId: device.id,
      });
    }
  }
  
  return tokens;
}

async function markTokenStale(deviceId: string) {
  await prisma.device.update({
    where: { id: deviceId },
    data: { pushToken: null, pushTokenType: null },
  });
}

/**
 * Register push token for device
 */
export async function registerPushToken(
  deviceId: string,
  token: string,
  type: 'fcm' | 'webpush'
) {
  await prisma.device.update({
    where: { id: deviceId },
    data: { pushToken: token, pushTokenType: type },
  });
}

/**
 * Send security alert push (high priority)
 */
export async function sendSecurityAlertPush(userId: string, title: string, body: string, deepLink: string) {
  return sendPush(userId, { title, body, deepLink, priority: 'high' });
}

/**
 * Send transactional push
 */
export async function sendTransactionalPush(userId: string, title: string, body: string, deepLink: string, data?: any) {
  return sendPush(userId, { title, body, deepLink, data, priority: 'normal' });
}

/**
 * Broadcast push to multiple users (for admin/system messages)
 */
export async function broadcastPush(userIds: string[], payload: PushPayload) {
  const results = await Promise.allSettled(
    userIds.map(id => sendPush(id, payload))
  );
  
  return results.map((r, i) => ({
    userId: userIds[i],
    success: r.status === 'fulfilled' && r.value,
  }));
}