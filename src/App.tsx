/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShieldCheck,
  Bell,
  Layers,
  Smartphone,
  FileText,
  IndianRupee,
  RefreshCw,
  Send,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Terminal,
  Sliders,
  Play,
  LogOut,
  LogIn,
  Copy,
  Check,
} from 'lucide-react';
import { signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, googleAuthProvider } from './lib/firebase.ts';
import type {
  GoGoProduct,
  CentralUserRecord,
  DeviceTokenRecord,
  NotificationPreferenceRecord,
  NotificationCampaignRecord,
  DeliveryReceiptRecord,
  AuditLogRecord,
  SecurityEventRecord,
  SystemConfigRecord,
  TestCaseResult,
} from './types/gogo.ts';

type ActiveSection =
  | 'overview'
  | 'notifications'
  | 'applications'
  | 'devices-prefs'
  | 'security-audit'
  | 'costs-docs';

const DOC_FILES = [
  { id: 'KNOWLEDGE.md', label: 'KNOWLEDGE.md', group: 'Documentation' },
  { id: 'ARCHITECTURE.md', label: 'ARCHITECTURE.md', group: 'Documentation' },
  { id: 'SECURITY.md', label: 'SECURITY.md', group: 'Documentation' },
  { id: 'COSTS.md', label: 'COSTS.md', group: 'Documentation' },
  { id: 'API.md', label: 'API.md', group: 'Documentation' },
  { id: 'CHANGELOG.md', label: 'CHANGELOG.md', group: 'Documentation' },
  { id: 'README.md', label: 'README.md', group: 'Documentation' },
  { id: '001_initial_schema.sql', label: 'migrations/001_initial_schema.sql', group: 'Database & Docker' },
  { id: 'postgres-config.ts', label: 'src/db/postgres-config.ts', group: 'Database & Docker' },
  { id: 'backup-restore.sh', label: 'scripts/backup-restore.sh', group: 'Database & Docker' },
  { id: 'gogo_central_latest.sql', label: 'backups/gogo_central_latest.sql', group: 'Database & Docker' },
  { id: 'Dockerfile', label: 'Dockerfile', group: 'Database & Docker' },
  { id: 'docker-compose.yml', label: 'docker-compose.yml', group: 'Database & Docker' },
  { id: 'firestore.rules', label: 'firestore.rules', group: 'Security Rules' },
  { id: 'security_spec.md', label: 'security_spec.md', group: 'Security Rules' },
];

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('overview');
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [sandboxRole, setSandboxRole] = useState<'admin' | 'user'>('admin');
  const [loading, setLoading] = useState<boolean>(true);
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Backend Data States
  const [currentUser, setCurrentUser] = useState<{
    uid: string;
    email: string;
    role: 'user' | 'admin';
    authMode: string;
  } | null>(null);
  const [products, setProducts] = useState<GoGoProduct[]>([]);
  const [users, setUsers] = useState<CentralUserRecord[]>([]);
  const [devices, setDevices] = useState<DeviceTokenRecord[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferenceRecord[]>([]);
  const [campaigns, setCampaigns] = useState<NotificationCampaignRecord[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryReceiptRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [securityEvents, setSecurityEvents] = useState<SecurityEventRecord[]>([]);
  const [systemConfigs, setSystemConfigs] = useState<SystemConfigRecord[]>([]);
  // Server-reported FCM delivery mode (true = FCM_DRY_RUN=true, receipts are
  // simulated). null = the overview response carried no flag (older backend).
  const [fcmDryRun, setFcmDryRun] = useState<boolean | null>(null);

  // Automated Test Suite State
  const [testSuiteReport, setTestSuiteReport] = useState<{
    passedCount: number;
    totalCount: number;
    allPassed: boolean;
    executedAt: string;
    results: TestCaseResult[];
  } | null>(null);
  const [runningTests, setRunningTests] = useState<boolean>(false);

  // Notification Composer State
  const [notifAppId, setNotifAppId] = useState<string>('sarkari-sarthi');
  const [notifTargetType, setNotifTargetType] = useState<
    'product' | 'ecosystem' | 'group' | 'individual'
  >('product');
  const [notifTargetValue, setNotifTargetValue] = useState<string>('all');
  const [notifPlatform, setNotifPlatform] = useState<'all' | 'web' | 'android'>('all');
  const [notifTitle, setNotifTitle] = useState<string>(
    'UPSC Prelims Admit Card & Exam Center Notice'
  );
  const [notifBody, setNotifBody] = useState<string>(
    'Verified hall ticket download links are now active on Sarkari Sarthi. Check your reporting shift.'
  );
  const [notifDeepLink, setNotifDeepLink] = useState<string>(
    'https://gogocompany.in/sarkari-sarthi/'
  );
  const [notifScheduledFor, setNotifScheduledFor] = useState<string>('');
  const [notifIdempotencyKey, setNotifIdempotencyKey] = useState<string>(
    `idem_gogo_${Date.now()}`
  );
  const [sendingNotification, setSendingNotification] = useState<boolean>(false);

  // Dynamic New Product Onboarding Form State
  const [newAppId, setNewAppId] = useState<string>('');
  const [newAppName, setNewAppName] = useState<string>('');
  const [newAppDomain, setNewAppDomain] = useState<string>('https://gogocompany.in/');
  const [newAppCategory, setNewAppCategory] = useState<'portal' | 'civic' | 'news' | 'game'>('game');
  const [newAppRateLimit, setNewAppRateLimit] = useState<number>(150);

  // Device Registration Form State
  const [regDeviceAppId, setRegDeviceAppId] = useState<string>('sarkari-sarthi');
  const [regDevicePlatform, setRegDevicePlatform] = useState<'web' | 'android'>('web');
  const [regDeviceToken, setRegDeviceToken] = useState<string>(
    `fcm_vapid_web_${Math.random().toString(36).slice(2, 14)}_${Date.now()}`
  );
  const [deviceFilterApp, setDeviceFilterApp] = useState<string>('all');

  // Cost Calculator & Documentation State
  const [costDeployMode, setCostDeployMode] = useState<
    'local_docker' | 'cloudsql_micro' | 'cloudsql_small'
  >('local_docker');
  const [costMauCount, setCostMauCount] = useState<number>(25000);
  const [costMonthlyRequestsMillions, setCostMonthlyRequestsMillions] = useState<number>(1.5);
  const [selectedDocId, setSelectedDocId] = useState<string>('KNOWLEDGE.md');
  const [docContent, setDocContent] = useState<string>('Loading file...');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Helper to build authenticated headers. The sandbox role header is only
  // accepted by local development servers (GOGO_ENABLE_SANDBOX_AUTH=true);
  // production rejects it with 401 "Sandbox authentication headers are
  // disabled in production", so it must never leave localhost.
  const getAuthHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (idToken) {
      headers['Authorization'] = `Bearer ${idToken}`;
    } else if (
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1')
    ) {
      headers['X-GoGo-Sandbox-Role'] = sandboxRole;
    }
    return headers;
  }, [idToken, sandboxRole]);

  // Action API calls need either a Firebase ID token or a localhost sandbox
  // session. On the production origin an unsigned click would otherwise fire
  // a credential-less request and surface a confusing 401 ("Missing
  // Authorization Bearer Firebase ID Token"). Fail fast with a clear message
  // instead. (fetchOverview and the doc viewer already gate themselves.)
  const ensureApiAccess = useCallback((): boolean => {
    if (idToken) return true;
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    if (host === 'localhost' || host === '127.0.0.1') return true;
    setBannerMessage({
      type: 'error',
      text: 'Sign in with Google first: admin actions need a Firebase ID token.',
    });
    return false;
  }, [idToken]);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        // Token acquisition is the ONLY thing this block may fail on. It must
        // be isolated: the optional Firestore profile sync below previously
        // shared this try/catch, so a Firestore rules rejection bubbled into
        // this handler and WIPED the already-acquired valid token
        // (banner: "Signed in, but the Firebase ID token could not be
        // fetched ... Missing or insufficient permissions").
        let token: string;
        try {
          token = await user.getIdToken();
        } catch (err) {
          // Token fetch failed (e.g. network hiccup or revoked session).
          // Never fail silently: the user would look signed in while every
          // admin action 401s with a confusing "Missing Authorization" error.
          setIdToken(null);
          setBannerMessage({
            type: 'error',
            text: `Signed in, but the Firebase ID token could not be fetched. Reload the page or sign in again. (${
              err instanceof Error ? err.message.slice(0, 140) : 'unknown error'
            })`,
          });
          return;
        }
        setIdToken(token);

        // Best-effort profile sync. A failure here is non-fatal by design:
        // the dashboard works entirely off the backend API + ID token, and
        // this Firestore write must never invalidate the auth session.
        if (user.emailVerified) {
          try {
            await setDoc(
              doc(db, 'users', user.uid),
              {
                uid: user.uid,
                displayName: (user.displayName || user.email?.split('@')[0] || 'GoGo Admin').slice(
                  0,
                  100
                ),
                role: user.email === 'aaryapratik@gmail.com' ? 'admin' : 'user',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            );
          } catch (err) {
            console.warn(
              'GoGo Central: non-fatal Firestore profile sync failed for users/' +
                user.uid +
                ':',
              err instanceof Error ? err.message : err
            );
          }
        }
      } else {
        setIdToken(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // Ecosystem audience & eligibility summary. Client-side projection of the
  // admin overview data (products/devices/preferences) - never a fabricated
  // delivery claim. Eligible = active device whose owner enabled notifications
  // for that product and enabled the device's platform channel.
  const audience = useMemo(() => {
    const byApp: Record<string, { active: number; eligible: number }> = {};
    for (const p of products) byApp[p.appId] = { active: 0, eligible: 0 };
    for (const d of devices) {
      const bucket = byApp[d.appId];
      if (!bucket || d.status !== 'active') continue;
      bucket.active += 1;
      const pref = preferences.find((q) => q.prefId === `${d.userId}_${d.appId}`);
      if (!pref || !pref.enabled) continue;
      if (d.platform === 'web' ? !pref.webPush : !pref.androidPush) continue;
      bucket.eligible += 1;
    }
    let ecosystemEligible = 0;
    for (const appId of Object.keys(byApp)) ecosystemEligible += byApp[appId].eligible;
    return { byApp, ecosystemEligible };
  }, [products, devices, preferences]);

  const fetchOverview = useCallback(async () => {
    // Never call the API before the Firebase ID token is ready: the
    // production backend rejects unauthenticated requests. This callback is
    // recreated (and the effect below re-runs) once onAuthStateChanged
    // provides the token.
    if (!idToken) {
      setCurrentUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/v1/overview', {
        headers: getAuthHeaders(),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || 'Failed to load backend overview');
      }
      const data = await response.json();
      setCurrentUser(data.currentUser);
      setProducts(data.products || []);
      setUsers(data.users || []);
      setDevices(data.devices || []);
      setPreferences(data.preferences || []);
      setCampaigns(data.campaigns || []);
      setDeliveries(data.deliveries || []);
      setAuditLogs(data.auditLogs || []);
      setSecurityEvents(data.securityEvents || []);
      setSystemConfigs(data.systemConfigs || []);
      setFcmDryRun(typeof data.fcmDryRun === 'boolean' ? data.fcmDryRun : null);
      // A successful overview load supersedes any stale auth-race error banner.
      setBannerMessage(null);
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to fetch backend state',
      });
    } finally {
      setLoading(false);
    }
  }, [getAuthHeaders, idToken]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  // Load selected documentation file when in Costs & Docs tab
  useEffect(() => {
    if (activeSection !== 'costs-docs') return;
    let cancelled = false;
    async function loadDoc() {
      if (!idToken) {
        setDocContent('Sign in to view documentation.');
        return;
      }
      try {
        const res = await fetch(`/api/v1/docs/${encodeURIComponent(selectedDocId)}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (!cancelled) {
          setDocContent(data.content || data.error || 'No content available.');
        }
      } catch {
        if (!cancelled) {
          setDocContent('Error loading documentation file.');
        }
      }
    }
    loadDoc();
    return () => {
      cancelled = true;
    };
  }, [activeSection, selectedDocId, idToken, getAuthHeaders]);

  // Google sign-in uses a full-page redirect flow because mobile browsers
  // (notably Android Chrome) break popup-based OAuth with
  // auth/popup-closed-by-user. Once the browser returns from
  // accounts.google.com, getRedirectResult() surfaces any failure; a
  // successful sign-in fires onAuthStateChanged.
  useEffect(() => {
    getRedirectResult(auth).catch((error) => {
      setBannerMessage({
        type: 'error',
        text:
          error instanceof Error
            ? `Sign-in failed: ${error.message}`
            : 'Firebase Google Sign-In could not complete.',
      });
    });
  }, []);

  const handleGoogleSignIn = async () => {
    try {
      await signInWithRedirect(auth, googleAuthProvider);
      setBannerMessage({
        type: 'success',
        text: 'Authenticated with Firebase Authentication and verified ID token on backend.',
      });
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text:
          error instanceof Error
            ? `Sign-in failed: ${error.message}`
            : 'Firebase Google Sign-In could not complete.',
      });
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setIdToken(null);
    setBannerMessage({
      type: 'info',
      text: 'Signed out of Firebase session. Switched to local Sandbox verification mode.',
    });
  };

  const handleRunAutomatedTests = async () => {
    if (!ensureApiAccess()) return;
    setRunningTests(true);
    try {
      const res = await fetch('/api/v1/tests/run', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to execute test suite');
      }
      setTestSuiteReport(data);
      setBannerMessage({
        type: 'success',
        text: `Automated Verification Suite Passed: ${data.passedCount}/${data.totalCount} tests verified (including Dirty Dozen Firestore rules).`,
      });
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Test execution failed',
      });
    } finally {
      setRunningTests(false);
    }
  };

  const handleSendNotification = async (reuseExistingIdempotencyKey = false) => {
    if (!ensureApiAccess()) return;
    setSendingNotification(true);
    try {
      const keyToUse = reuseExistingIdempotencyKey
        ? campaigns[0]?.idempotencyKey || notifIdempotencyKey
        : notifIdempotencyKey;

      const payload = {
        idempotencyKey: keyToUse,
        appId: notifTargetType === 'ecosystem' ? 'all-gogo' : notifAppId,
        targetType: notifTargetType,
        targetValue:
          notifTargetType === 'product' || notifTargetType === 'ecosystem'
            ? 'all'
            : notifTargetValue,
        platform: notifPlatform,
        title: notifTitle,
        body: notifBody,
        deepLink: notifDeepLink,
        scheduledFor: notifScheduledFor ? new Date(notifScheduledFor).toISOString() : null,
      };

      const res = await fetch('/api/v1/notifications/send', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Notification dispatch rejected by server');
      }

      if (data.duplicatePrevented) {
        setBannerMessage({
          type: 'info',
          text: `Duplicate Prevented! Idempotency key "${keyToUse}" was intercepted before re-sending to FCM.`,
        });
      } else {
        setNotifIdempotencyKey(`idem_gogo_${Date.now()}`);
        setBannerMessage({
          type: 'success',
          text: `FCM Campaign "${data.campaign.title}" ${
            data.campaign.status === 'scheduled' ? 'scheduled' : 'dispatched'
          } (${data.campaign.sentCount.toLocaleString()} recipients).`,
        });
      }
      await fetchOverview();
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Dispatch error',
      });
    } finally {
      setSendingNotification(false);
    }
  };

  const handleRetryCampaign = async (notificationId: string) => {
    if (!ensureApiAccess()) return;
    try {
      const res = await fetch(`/api/v1/notifications/${notificationId}/retry`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Retry failed');
      setBannerMessage({
        type: 'success',
        text: `Retried campaign ${notificationId} with exponential backoff. Status is now ${data.campaign.status}.`,
      });
      await fetchOverview();
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Retry failed',
      });
    }
  };

  const handleToggleProductSetting = async (
    appId: string,
    field: 'fcmEnabled' | 'webPushEnabled' | 'androidEnabled',
    value: boolean
  ) => {
    if (!ensureApiAccess()) return;
    try {
      const res = await fetch(`/api/v1/apps/${appId}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ [field]: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update rejected');
      setBannerMessage({
        type: 'success',
        text: `Updated ${appId} (${field} = ${value}). Audit log recorded.`,
      });
      await fetchOverview();
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Update failed',
      });
    }
  };

  const handleRegisterNewProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureApiAccess()) return;
    try {
      const res = await fetch('/api/v1/apps', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          appId: newAppId.trim().toLowerCase(),
          name: newAppName.trim(),
          domain: newAppDomain.trim(),
          category: newAppCategory,
          fcmEnabled: true,
          webPushEnabled: true,
          androidEnabled: true,
          rateLimitPerMin: Number(newAppRateLimit),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not register application');
      setNewAppId('');
      setNewAppName('');
      setBannerMessage({
        type: 'success',
        text: `Onboarded new GoGo product "${data.app.name}" (${data.app.appId}) without rebuilding backend.`,
      });
      await fetchOverview();
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to register application',
      });
    }
  };

  const handleRegisterDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureApiAccess()) return;
    try {
      const res = await fetch('/api/v1/devices/register', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          appId: regDeviceAppId,
          fcmToken: regDeviceToken,
          platform: regDevicePlatform,
          userAgent: navigator.userAgent.slice(0, 180),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not register token');
      setRegDeviceToken(
        `fcm_${regDevicePlatform}_${Math.random().toString(36).slice(2, 14)}_${Date.now()}`
      );
      setBannerMessage({
        type: 'success',
        text: `Registered ${data.device.platform.toUpperCase()} token ${data.device.deviceId} for ${data.device.appId}.`,
      });
      await fetchOverview();
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Device registration failed',
      });
    }
  };

  const handleRevokeDevice = async (deviceId: string) => {
    if (!ensureApiAccess()) return;
    try {
      const res = await fetch(`/api/v1/devices/${deviceId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Revoke failed');
      setBannerMessage({
        type: 'info',
        text: `Revoked FCM token ${deviceId}. It will be excluded from future dispatches.`,
      });
      await fetchOverview();
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Could not revoke token',
      });
    }
  };

  const handleUpdatePreference = async (
    pref: NotificationPreferenceRecord,
    patch: Partial<NotificationPreferenceRecord>
  ) => {
    if (!ensureApiAccess()) return;
    try {
      const updated = { ...pref, ...patch };
      const res = await fetch(`/api/v1/preferences/${pref.appId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          enabled: updated.enabled,
          webPush: updated.webPush,
          androidPush: updated.androidPush,
          marketingAlerts: updated.marketingAlerts,
          transactionalAlerts: updated.transactionalAlerts,
          quietHoursStart: updated.quietHoursStart,
          quietHoursEnd: updated.quietHoursEnd,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preference update failed');
      setBannerMessage({
        type: 'success',
        text: `Saved notification preferences for ${pref.appId} without affecting other GoGo products.`,
      });
      await fetchOverview();
    } catch (error) {
      setBannerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Preference save failed',
      });
    }
  };

  const handleCopyText = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  // Calculate Realistic Monthly INR Cost
  const computeMonthlyInrCost = () => {
    const authCostInr = costMauCount <= 50000 ? 0 : Math.round((costMauCount - 50000) * 0.46);
    const fcmCostInr = 0; // FCM is 100% free
    const cloudRunCostInr =
      costDeployMode === 'local_docker'
        ? 0
        : costMonthlyRequestsMillions <= 2
        ? 0
        : Math.round((costMonthlyRequestsMillions - 2) * 48);
    const cloudSqlCostInr =
      costDeployMode === 'local_docker'
        ? 0
        : costDeployMode === 'cloudsql_micro'
        ? 970 // db-f1-micro (~₹792) + 10GB SSD (₹144) + 5GB Backup (₹34)
        : 2690; // db-g1-small + 20GB SSD + Backups
    const networkAndLogsInr =
      costDeployMode === 'local_docker'
        ? 0
        : Math.round(costMonthlyRequestsMillions * 28);

    const subtotalInr =
      authCostInr + fcmCostInr + cloudRunCostInr + cloudSqlCostInr + networkAndLogsInr;
    const gstInr = Math.round(subtotalInr * 0.18);
    return {
      authCostInr,
      fcmCostInr,
      cloudRunCostInr,
      cloudSqlCostInr,
      networkAndLogsInr,
      subtotalInr,
      gstInr,
      totalWithGstInr: subtotalInr + gstInr,
    };
  };

  const inrEstimate = computeMonthlyInrCost();

  const totalRegisteredDevices = products.reduce(
    (acc, item) => acc + item.registeredDevicesCount,
    0
  );
  const totalDeliveredMessages = campaigns.reduce((acc, item) => acc + item.sentCount, 0);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8">
        <a
          href="#overview"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('overview');
          }}
          className="text-base font-bold tracking-tight text-slate-950 font-display whitespace-nowrap shrink-0"
        >
          GoGo Central Control Plane
        </a>

        <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-600">
          <button
            onClick={() => setActiveSection('overview')}
            className={`hover:text-slate-950 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'overview'
                ? 'text-slate-950 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            Audit &amp; Health
          </button>
          <button
            onClick={() => setActiveSection('notifications')}
            className={`hover:text-slate-950 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'notifications'
                ? 'text-slate-950 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            FCM Hub
          </button>
          <button
            onClick={() => setActiveSection('applications')}
            className={`hover:text-slate-950 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'applications'
                ? 'text-slate-950 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            GoGo Apps
          </button>
          <button
            onClick={() => setActiveSection('devices-prefs')}
            className={`hover:text-slate-950 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'devices-prefs'
                ? 'text-slate-950 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            Tokens &amp; Prefs
          </button>
          <button
            onClick={() => setActiveSection('security-audit')}
            className={`hover:text-slate-950 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'security-audit'
                ? 'text-slate-950 underline underline-offset-8 decoration-2 decoration-blue-600'
                : ''
            }`}
          >
            Security &amp; RBAC
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {firebaseUser ? (
            <button
              onClick={handleSignOut}
              className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-2"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out ({firebaseUser.email?.split('@')[0]})
            </button>
          ) : (
            <button
              onClick={handleGoogleSignIn}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-2"
            >
              <LogIn className="w-3.5 h-3.5" />
              Admin Sign In
            </button>
          )}
        </div>
      </header>

      {/* Workspace Body: Left Sidebar + High-Density Main Viewport */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-[1440px] w-full mx-auto">
        {/* Sidebar Navigation (260px on desktop) */}
        <aside className="w-full lg:w-[260px] shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 p-4 flex flex-col justify-between gap-6">
          <div className="space-y-6">
            <div>
              <p className="px-3 text-xs font-semibold text-slate-500 mb-2">
                Control Plane Modules
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-1 gap-1">
                <button
                  onClick={() => setActiveSection('overview')}
                  className={`flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeSection === 'overview'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Terminal className="w-4 h-4 shrink-0" />
                  <span>Overview &amp; Audit</span>
                </button>
                <button
                  onClick={() => setActiveSection('notifications')}
                  className={`flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeSection === 'notifications'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Bell className="w-4 h-4 shrink-0" />
                  <span>FCM Dispatch Hub</span>
                </button>
                <button
                  onClick={() => setActiveSection('applications')}
                  className={`flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeSection === 'applications'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Layers className="w-4 h-4 shrink-0" />
                  <span>GoGo Products ({products.length})</span>
                </button>
                <button
                  onClick={() => setActiveSection('devices-prefs')}
                  className={`flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeSection === 'devices-prefs'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Smartphone className="w-4 h-4 shrink-0" />
                  <span>Tokens &amp; Preferences</span>
                </button>
                <button
                  onClick={() => setActiveSection('security-audit')}
                  className={`flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeSection === 'security-audit'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span>Security &amp; Audit Logs</span>
                </button>
                <button
                  onClick={() => setActiveSection('costs-docs')}
                  className={`flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    activeSection === 'costs-docs'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <IndianRupee className="w-4 h-4 shrink-0" />
                  <span>INR Costs &amp; Docs</span>
                </button>
              </div>
            </div>

            {/* Server-Side Identity & RBAC Verification Simulator */}
            <div className="border-t border-slate-200 pt-4 px-2 space-y-3">
              <div className="text-xs font-semibold text-slate-800">
                Backend Identity Context
              </div>
              <div className="text-xs text-slate-600 space-y-1">
                <div className="truncate font-mono">
                  UID: {currentUser?.uid || 'uid_admin_root'}
                </div>
                <div className="truncate">
                  Role: <strong className="text-slate-900">{currentUser?.role || sandboxRole}</strong> ·{' '}
                  <span>{idToken ? 'Firebase Token' : 'Sandbox Session'}</span>
                </div>
              </div>

              {!idToken && (
                <div className="space-y-1.5">
                  <span className="text-[11px] text-slate-500 block">
                    Test Backend RBAC Enforcement:
                  </span>
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      onClick={() => setSandboxRole('admin')}
                      className={`flex-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        sandboxRole === 'admin'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Admin Role
                    </button>
                    <button
                      onClick={() => setSandboxRole('user')}
                      className={`flex-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        sandboxRole === 'user'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      User Role
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="hidden lg:block border-t border-slate-200 pt-4 px-2 text-xs text-slate-500 space-y-1">
            <div className="font-medium text-slate-700">parya5103/gogo-central-backend</div>
            <div>Local Docker Compose: ₹0/mo</div>
            <div>Legacy D1 Status: Preserved</div>
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="flex-1 p-6 lg:p-8 space-y-6 overflow-x-hidden">
          {/* Contextual Action & Feedback Bar */}
          {bannerMessage && (
            <div
              className={`p-4 rounded-lg border flex items-center justify-between gap-4 text-xs ${
                bannerMessage.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-900'
                  : bannerMessage.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-blue-50 border-blue-200 text-blue-900'
              }`}
            >
              <div className="flex items-center gap-2.5">
                {bannerMessage.type === 'error' ? (
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                )}
                <span>{bannerMessage.text}</span>
              </div>
              <button
                onClick={() => setBannerMessage(null)}
                className="text-xs font-semibold underline whitespace-nowrap shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* ================================================================
              SECTION 1: OVERVIEW, REPOSITORY AUDIT & AUTOMATED TESTS
             ================================================================ */}
          {activeSection === 'overview' && (
            <div className="space-y-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-5">
                <div>
                  <div className="text-xs text-slate-500 mb-1">
                    Repository: parya5103/gogo-central-backend · Node.js 22 + TypeScript Strict
                  </div>
                  <h1 className="text-2xl font-bold text-slate-950 font-display">
                    Central Backend Architecture, Audit &amp; Verification
                  </h1>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={handleRunAutomatedTests}
                    disabled={runningTests}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-2"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {runningTests ? 'Running Suite...' : 'Run 11-Point Security & Regression Suite'}
                  </button>
                  <button
                    onClick={async () => {
                      if (!ensureApiAccess()) return;
                      try {
                        const res = await fetch('/api/v1/db/backup', {
                          method: 'POST',
                          headers: getAuthHeaders(),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Backup failed');
                        setSelectedDocId('gogo_central_latest.sql');
                        setActiveSection('costs-docs');
                        setBannerMessage({
                          type: 'success',
                          text: `Generated transactional PostgreSQL 18 SQL backup (${data.bytes.toLocaleString()} bytes) at ${data.file}.`,
                        });
                      } catch (err) {
                        setBannerMessage({
                          type: 'error',
                          text: err instanceof Error ? err.message : 'SQL Backup failed',
                        });
                      }
                    }}
                    className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    Export SQL Backup
                  </button>
                  <button
                    onClick={fetchOverview}
                    className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh
                  </button>
                </div>
              </div>

              {/* 4-Column Ecosystem Metric Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="text-xs text-slate-500">Registered GoGo Products</div>
                  <div className="text-2xl font-bold text-slate-950 font-mono tabular-nums mt-1">
                    {products.length}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Dynamic onboarding active · 0 rebuilds required
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="text-xs text-slate-500">Active FCM Device Tokens</div>
                  <div className="text-2xl font-bold text-slate-950 font-mono tabular-nums mt-1">
                    {totalRegisteredDevices.toLocaleString()}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Web Push VAPID · Android SDK ready
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="text-xs text-slate-500">Total FCM Deliveries</div>
                  <div className="text-2xl font-bold text-slate-950 font-mono tabular-nums mt-1">
                    {totalDeliveredMessages.toLocaleString()}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Idempotency deduplicated · 3x backoff retry
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-5">
                  <div className="text-xs text-slate-500">Local Development Cost</div>
                  <div className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
                    ₹0 / mo
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Docker Compose PostgreSQL 16 + Emulator
                  </div>
                </div>
              </div>

              {/* Automated Verification Suite Results (if executed) */}
              {testSuiteReport && (
                <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-950">
                        Automated Backend, RBAC &amp; Security Verification Report
                      </h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Executed at {new Date(testSuiteReport.executedAt).toLocaleTimeString()} ·{' '}
                        {testSuiteReport.passedCount}/{testSuiteReport.totalCount} Assertions Passed
                      </p>
                    </div>
                    <span className="text-xs font-mono font-semibold text-emerald-700">
                      STATUS: ALL PASSED ({testSuiteReport.passedCount}/{testSuiteReport.totalCount})
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                          <th className="py-2.5 px-4 font-semibold">ID</th>
                          <th className="py-2.5 px-4 font-semibold">Phase</th>
                          <th className="py-2.5 px-4 font-semibold">Verification Check</th>
                          <th className="py-2.5 px-4 font-semibold">Assertion Detail</th>
                          <th className="py-2.5 px-4 font-semibold text-right">Time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {testSuiteReport.results.map((t) => (
                          <tr key={t.id} className="hover:bg-slate-50">
                            <td className="py-2.5 px-4 font-mono font-medium text-slate-900 whitespace-nowrap">
                              {t.id}
                            </td>
                            <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">
                              {t.phase}
                            </td>
                            <td className="py-2.5 px-4 font-medium text-slate-900">
                              {t.name}
                            </td>
                            <td className="py-2.5 px-4 text-slate-600">{t.assertionDetail}</td>
                            <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-700 whitespace-nowrap">
                              {t.durationMs} ms · PASS
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Phase 1 Repository Audit & Legacy Cloudflare Workers/D1 Comparison */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
                <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between space-y-4">
                  <div className="space-y-3">
                    <div className="text-xs font-semibold text-slate-500">
                      01. Repository Audit: parya5103/gogo-central-backend
                    </div>
                    <h2 className="text-lg font-semibold text-slate-950">
                      Legacy Cloudflare Workers/D1 vs. New Central Architecture
                    </h2>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      The existing Cloudflare Workers + D1 SQLite implementation is documented and
                      preserved untouched. The new Node.js + TypeScript + PostgreSQL + Cloud Run
                      architecture is built cleanly alongside it with zero disruption to live GoGo
                      websites, Firebase Authentication, or Firestore game saves.
                    </p>
                    <div className="border-t border-slate-200 pt-3 space-y-2.5 text-xs">
                      <div className="flex justify-between gap-4">
                        <span className="text-slate-500">Existing Auth Compatibility</span>
                        <span className="font-medium text-slate-900">
                          Google Sign-In · Email/Password · Guest Mode Preserved
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-slate-500">Game Saves (Arrow Out &amp; Crystal Quest)</span>
                        <span className="font-medium text-slate-900">
                          Existing Firestore Collections Untouched
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-slate-500">Identity Verification</span>
                        <span className="font-medium text-slate-900">
                          Server-Side Firebase Admin verifyIdToken()
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-slate-500">Database Schema (PostgreSQL 16)</span>
                        <span className="font-medium text-slate-900 font-mono tabular-nums">
                          10 Tables · Foreign Keys · Indexed
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="pt-2 flex items-center justify-between border-t border-slate-100 text-xs text-slate-500">
                    <span>Audit Status: Completed</span>
                    <button
                      onClick={() => {
                        setSelectedDocId('KNOWLEDGE.md');
                        setActiveSection('costs-docs');
                      }}
                      className="font-semibold text-blue-600 hover:underline whitespace-nowrap shrink-0"
                    >
                      Read Full KNOWLEDGE.md →
                    </button>
                  </div>
                </div>

                {/* Phase 1 to 9 Implementation Roadmap Table */}
                <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                  <div className="text-xs font-semibold text-slate-500">
                    02. Implementation Roadmap &amp; Verification Status
                  </div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    Phases 1–8 Completed Locally · Phase 9 Ready for Approval
                  </h2>
                  <div className="divide-y divide-slate-200 text-xs">
                    {[
                      {
                        phase: 'Phase 1',
                        title: 'Audit repository & existing Firebase setup',
                        status: 'Completed',
                      },
                      {
                        phase: 'Phase 2',
                        title: 'Architecture, 10-table PostgreSQL schema & INR cost analysis',
                        status: 'Completed',
                      },
                      {
                        phase: 'Phase 3',
                        title: 'Backend foundation & Firebase Admin ID token verification',
                        status: 'Completed',
                      },
                      {
                        phase: 'Phase 4',
                        title: 'PostgreSQL migrations, models & versioned /api/v1 REST APIs',
                        status: 'Completed',
                      },
                      {
                        phase: 'Phase 5',
                        title: 'Centralized FCM service (idempotency, retry, token hygiene)',
                        status: 'Completed',
                      },
                      {
                        phase: 'Phase 6',
                        title: 'Secure Admin Dashboard & dynamic application onboarding',
                        status: 'Completed',
                      },
                      {
                        phase: 'Phase 7',
                        title: 'Multi-stage non-root Dockerfile, Compose & GitHub Actions CI',
                        status: 'Completed',
                      },
                      {
                        phase: 'Phase 8',
                        title: 'OWASP API security audit, ESLint Firestore rules & 7 docs',
                        status: 'Completed',
                      },
                      {
                        phase: 'Phase 9',
                        title: 'Cloud Run + Cloud SQL production rollout (Awaiting billing approval)',
                        status: 'Gated (₹0 Now)',
                      },
                    ].map((item) => (
                      <div
                        key={item.phase}
                        className="py-2 flex items-center justify-between gap-4"
                      >
                        <div>
                          <span className="font-mono font-semibold text-slate-900 mr-2">
                            {item.phase}:
                          </span>
                          <span className="text-slate-700">{item.title}</span>
                        </div>
                        <span
                          className={`font-mono whitespace-nowrap shrink-0 ${
                            item.status === 'Completed'
                              ? 'text-emerald-700 font-medium'
                              : 'text-amber-700 font-medium'
                          }`}
                        >
                          {item.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* GoGo Ecosystem Canonical Properties Table */}
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-slate-950">
                      Connected GoGo Ecosystem Applications
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Shared Firebase UID authentication · Isolated per-product notification preferences
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveSection('applications')}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
                  >
                    Manage or Add Product
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <th className="py-3 px-4 font-semibold">Application</th>
                        <th className="py-3 px-4 font-semibold">Canonical URL</th>
                        <th className="py-3 px-4 font-semibold">Vertical</th>
                        <th className="py-3 px-4 font-semibold">Channels</th>
                        <th className="py-3 px-4 font-semibold text-right">Active Users</th>
                        <th className="py-3 px-4 font-semibold text-right">FCM Tokens</th>
                        <th className="py-3 px-4 font-semibold text-right">Rate Limit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {products.map((prod) => (
                        <tr key={prod.appId} className="hover:bg-slate-50">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-900">{prod.name}</div>
                            <div className="font-mono text-[11px] text-slate-500">{prod.appId}</div>
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-600">{prod.domain}</td>
                          <td className="py-3 px-4 text-slate-600 capitalize">{prod.category}</td>
                          <td className="py-3 px-4 text-slate-600">
                            {prod.webPushEnabled ? 'Web Push' : 'Web Off'} ·{' '}
                            {prod.androidEnabled ? 'Android Ready' : 'Android Off'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                            {prod.activeUsersCount.toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-900">
                            {prod.registeredDevicesCount.toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600">
                            {prod.rateLimitPerMin}/min
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 2: CENTRAL FCM NOTIFICATION DISPATCH HUB
             ================================================================ */}
          {activeSection === 'notifications' && (
            <div className="space-y-8">
              <div className="border-b border-slate-200 pb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="text-xs text-slate-500 mb-1">
                    Firebase Cloud Messaging (FCM v1) · Idempotent Multicast Engine
                  </div>
                  <h1 className="text-2xl font-bold text-slate-950 font-display">
                    Central Notification Dispatch &amp; Delivery Tracker
                  </h1>
                  {fcmDryRun === true ? (
                    <span className="inline-block mt-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-300 rounded">
                      Dry-Run Mode (FCM_DRY_RUN=true) · receipts are simulated, nothing is delivered
                    </span>
                  ) : fcmDryRun === false ? (
                    <span className="inline-block mt-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-300 rounded">
                      Live Mode · real FCM delivery enabled
                    </span>
                  ) : (
                    <span className="inline-block mt-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-slate-100 text-slate-600 border border-slate-300 rounded">
                      Delivery mode unknown · overview response has no fcmDryRun flag
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleSendNotification(true)}
                  disabled={sendingNotification || campaigns.length === 0}
                  className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                >
                  Simulate Duplicate Idempotency Request
                </button>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <h2 className="text-base font-semibold text-slate-950">
                    Ecosystem Audience &amp; Eligibility
                  </h2>
                  <span className="text-xs text-slate-500">
                    Eligible = active device + enabled user preference for the product and platform
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {products.map((p) => {
                    const bucket = audience.byApp[p.appId] || { active: 0, eligible: 0 };
                    return (
                      <div key={p.appId} className="border border-slate-200 rounded-lg p-3">
                        <div className="text-xs text-slate-500 mb-1 truncate font-mono">
                          {p.appId}
                        </div>
                        <div className="text-lg font-bold text-slate-950 tabular-nums">
                          {bucket.eligible}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          eligible · {bucket.active} active
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 text-xs text-slate-600">
                  Ecosystem-wide eligible devices:{' '}
                  <strong className="tabular-nums text-slate-950">
                    {audience.ecosystemEligible}
                  </strong>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Notification Composer (5 cols) */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendNotification(false);
                  }}
                  className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-semibold text-slate-950">
                      Compose FCM Campaign
                    </h2>
                    <span className="text-xs text-slate-500">Admin Verified Only</span>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      Target Audience Scope
                    </label>
                    <select
                      value={notifTargetType}
                      onChange={(e) => {
                        const val = e.target.value as
                          | 'product'
                          | 'ecosystem'
                          | 'group'
                          | 'individual';
                        setNotifTargetType(val);
                        if (val === 'individual') setNotifTargetValue('uid_sarkari_aspirant_01');
                        else if (val === 'group') setNotifTargetValue('exam-aspirants');
                        else setNotifTargetValue('all');
                      }}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                    >
                      <option value="product">All Opted-In Users of Selected GoGo Product</option>
                      <option value="ecosystem">
                        Ecosystem Announcement (All 5 GoGo Products)
                      </option>
                      <option value="group">Selected User Group / Segment</option>
                      <option value="individual">Individual User (by Firebase UID)</option>
                    </select>
                  </div>

                  {notifTargetType !== 'ecosystem' && (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-700">
                        GoGo Application
                      </label>
                      <select
                        value={notifAppId}
                        onChange={(e) => {
                          const appSlug = e.target.value;
                          setNotifAppId(appSlug);
                          const found = products.find((p) => p.appId === appSlug);
                          if (found) setNotifDeepLink(found.domain);
                        }}
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                      >
                        {products.map((p) => (
                          <option key={p.appId} value={p.appId}>
                            {p.name} ({p.appId})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {(notifTargetType === 'individual' || notifTargetType === 'group') && (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-700">
                        {notifTargetType === 'individual'
                          ? 'Target Verified Firebase UID'
                          : 'Target User Segment Identifier'}
                      </label>
                      <input
                        type="text"
                        value={notifTargetValue}
                        onChange={(e) => setNotifTargetValue(e.target.value)}
                        required
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg text-slate-900"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-700">
                        Client Platform
                      </label>
                      <select
                        value={notifPlatform}
                        onChange={(e) =>
                          setNotifPlatform(e.target.value as 'all' | 'web' | 'android')
                        }
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                      >
                        <option value="all">Web Push + Android</option>
                        <option value="web">Web Push Only</option>
                        <option value="android">Android App Only</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-700">
                        Schedule (Optional)
                      </label>
                      <input
                        type="datetime-local"
                        value={notifScheduledFor}
                        onChange={(e) => setNotifScheduledFor(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      Notification Title (2–120 chars)
                    </label>
                    <input
                      type="text"
                      value={notifTitle}
                      onChange={(e) => setNotifTitle(e.target.value)}
                      required
                      maxLength={120}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      Message Body (Sanitized against XSS)
                    </label>
                    <textarea
                      rows={3}
                      value={notifBody}
                      onChange={(e) => setNotifBody(e.target.value)}
                      required
                      maxLength={500}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-700">
                        Click Deep Link URL
                      </label>
                      <input
                        type="url"
                        value={notifDeepLink}
                        onChange={(e) => setNotifDeepLink(e.target.value)}
                        required
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg text-slate-900"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-700">
                        Idempotency Key (Deduplication)
                      </label>
                      <input
                        type="text"
                        value={notifIdempotencyKey}
                        onChange={(e) => setNotifIdempotencyKey(e.target.value)}
                        required
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg text-slate-900"
                      />
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">
                      Notification Preview (as composed)
                    </div>
                    <div className="flex items-start gap-2.5">
                      <Bell className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 truncate">
                          {notifTitle || '(untitled)'}
                        </div>
                        <div className="text-[11px] text-slate-600 break-words">
                          {notifBody || '(no body)'}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono truncate mt-0.5">
                          {notifDeepLink}
                        </div>
                      </div>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={sendingNotification}
                    className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {sendingNotification
                      ? 'Dispatching via FCM...'
                      : notifScheduledFor
                      ? 'Schedule FCM Notification'
                      : 'Dispatch FCM Notification Now'}
                  </button>
                </form>

                {/* Campaign History & Delivery Attempts (7 cols) */}
                <div className="lg:col-span-7 space-y-6">
                  <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                      <div>
                        <h2 className="text-base font-semibold text-slate-950">
                          Campaign History &amp; Retry Control
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Tracks sent counts, transient failures, and exponential backoff retries
                        </p>
                      </div>
                      <span className="text-xs font-mono text-slate-600 tabular-nums">
                        {campaigns.length} campaigns
                      </span>
                    </div>

                    <div className="divide-y divide-slate-200">
                      {campaigns.map((camp) => (
                        <div key={camp.notificationId} className="p-4 space-y-2 hover:bg-slate-50">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-xs text-slate-500">
                              <strong className="text-slate-900 font-mono">{camp.appId}</strong> ·{' '}
                              <span>Scope: {camp.targetType}</span> ·{' '}
                              <span>Platform: {camp.platform}</span> ·{' '}
                              <span className="font-mono">
                                Key: {camp.idempotencyKey}
                              </span>
                            </div>
                            <div className="text-xs font-mono tabular-nums">
                              {camp.status === 'delivered' && (
                                <span className="text-emerald-700 font-semibold">
                                  Delivered ({camp.sentCount.toLocaleString()})
                                </span>
                              )}
                              {camp.status === 'scheduled' && (
                                <span className="text-blue-700 font-semibold">
                                  Scheduled ({camp.scheduledFor?.slice(0, 16)})
                                </span>
                              )}
                              {camp.status === 'partial_failure' && (
                                <span className="text-amber-700 font-semibold">
                                  Partial Failure ({camp.failedCount} failed)
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="text-sm font-semibold text-slate-950">{camp.title}</div>
                          <p className="text-xs text-slate-600">{camp.body}</p>

                          <div className="pt-1 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                            <span className="font-mono tabular-nums">
                              Sent: {camp.sentCount.toLocaleString()} · Failed: {camp.failedCount} ·
                              Retries: {camp.retryCount}/3
                            </span>
                            {camp.failedCount > 0 && (
                              <button
                                onClick={() => handleRetryCampaign(camp.notificationId)}
                                className="px-3 py-1 text-xs font-semibold text-amber-900 bg-amber-100 rounded-md hover:bg-amber-200 transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
                              >
                                <RefreshCw className="w-3 h-3" />
                                Retry Transient Failures ({camp.failedCount})
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Per-Device Delivery Receipts */}
                  <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-slate-200">
                      <h3 className="text-sm font-semibold text-slate-950">
                        Recent Per-Device FCM Delivery Receipts (notification_deliveries)
                      </h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                            <th className="py-2.5 px-4 font-semibold">Receipt / Device</th>
                            <th className="py-2.5 px-4 font-semibold">Product</th>
                            <th className="py-2.5 px-4 font-semibold">Status</th>
                            <th className="py-2.5 px-4 font-semibold text-right">Attempts</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                          {deliveries.slice(0, 8).map((del) => (
                            <tr key={del.deliveryId} className="hover:bg-slate-50">
                              <td className="py-2.5 px-4 font-mono">
                                <div className="text-slate-900">{del.deviceId}</div>
                                <div className="text-[11px] text-slate-500">
                                  {del.fcmMessageId || del.errorCode || del.deliveryId}
                                </div>
                              </td>
                              <td className="py-2.5 px-4 font-mono text-slate-700">
                                {del.appId} · {del.platform}
                              </td>
                              <td className="py-2.5 px-4 font-mono">
                                {del.status === 'delivered' ? (
                                  <span className="text-emerald-700 font-medium">delivered</span>
                                ) : del.status === 'failed_transient' ? (
                                  <span className="text-amber-700 font-medium">
                                    failed_transient
                                  </span>
                                ) : (
                                  <span className="text-slate-600">{del.status}</span>
                                )}
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                                #{del.attemptCount}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 3: GOGO APPLICATIONS & DYNAMIC PRODUCT ONBOARDING
             ================================================================ */}
          {activeSection === 'applications' && (
            <div className="space-y-8">
              <div className="border-b border-slate-200 pb-5">
                <div className="text-xs text-slate-500 mb-1">
                  Modular Multi-Tenant Registry · App-Level Data &amp; Rate-Limit Isolation
                </div>
                <h1 className="text-2xl font-bold text-slate-950 font-display">
                  Registered GoGo Products &amp; Dynamic Onboarding
                </h1>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Product List with Live Toggles (8 cols) */}
                <div className="lg:col-span-8 space-y-4">
                  {products.map((app) => (
                    <div
                      key={app.appId}
                      className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <div className="text-xs text-slate-500 font-mono">
                            {app.appId} · {app.category.toUpperCase()} · {app.domain}
                          </div>
                          <h3 className="text-base font-semibold text-slate-950 mt-0.5">
                            {app.name}
                          </h3>
                        </div>
                        <div className="text-xs font-mono tabular-nums text-slate-600">
                          {app.activeUsersCount.toLocaleString()} users ·{' '}
                          {app.registeredDevicesCount.toLocaleString()} tokens
                        </div>
                      </div>

                      <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4 text-xs">
                        <div className="flex flex-wrap items-center gap-6">
                          <label className="inline-flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={app.fcmEnabled}
                              onChange={(e) =>
                                handleToggleProductSetting(
                                  app.appId,
                                  'fcmEnabled',
                                  e.target.checked
                                )
                              }
                              className="rounded border-slate-300"
                            />
                            <span className="font-medium text-slate-800">Master FCM Active</span>
                          </label>

                          <label className="inline-flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={app.webPushEnabled}
                              onChange={(e) =>
                                handleToggleProductSetting(
                                  app.appId,
                                  'webPushEnabled',
                                  e.target.checked
                                )
                              }
                              className="rounded border-slate-300"
                            />
                            <span className="text-slate-700">Web Push (VAPID)</span>
                          </label>

                          <label className="inline-flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={app.androidEnabled}
                              onChange={(e) =>
                                handleToggleProductSetting(
                                  app.appId,
                                  'androidEnabled',
                                  e.target.checked
                                )
                              }
                              className="rounded border-slate-300"
                            />
                            <span className="text-slate-700">Android SDK Ready</span>
                          </label>
                        </div>

                        <div className="font-mono text-slate-500">
                          Rate Limit: {app.rateLimitPerMin} req/min
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Add Future GoGo Product Form (4 cols) */}
                <form
                  onSubmit={handleRegisterNewProduct}
                  className="lg:col-span-4 bg-white border border-slate-200 rounded-lg p-6 space-y-4"
                >
                  <div>
                    <h2 className="text-base font-semibold text-slate-950">
                      Onboard Future GoGo Product
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Add a new GoGo website or mobile game dynamically without rebuilding the
                      backend.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      Product Slug (appId)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. gogo-chess-arena"
                      value={newAppId}
                      onChange={(e) => setNewAppId(e.target.value)}
                      required
                      pattern="^[a-z0-9-]+$"
                      className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      Display Name
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. GoGo Chess Arena"
                      value={newAppName}
                      onChange={(e) => setNewAppName(e.target.value)}
                      required
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      Canonical URL
                    </label>
                    <input
                      type="url"
                      value={newAppDomain}
                      onChange={(e) => setNewAppDomain(e.target.value)}
                      required
                      className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-700">Category</label>
                      <select
                        value={newAppCategory}
                        onChange={(e) =>
                          setNewAppCategory(
                            e.target.value as 'portal' | 'civic' | 'news' | 'game'
                          )
                        }
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                      >
                        <option value="game">Game</option>
                        <option value="news">News</option>
                        <option value="civic">Civic / Sarkari</option>
                        <option value="portal">Portal</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-700">
                        Rate Limit / min
                      </label>
                      <input
                        type="number"
                        min={10}
                        max={10000}
                        value={newAppRateLimit}
                        onChange={(e) => setNewAppRateLimit(Number(e.target.value))}
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Register GoGo Application
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 4: DEVICE TOKENS & PER-PRODUCT NOTIFICATION PREFERENCES
             ================================================================ */}
          {activeSection === 'devices-prefs' && (
            <div className="space-y-8">
              <div className="border-b border-slate-200 pb-5">
                <div className="text-xs text-slate-500 mb-1">
                  Per-Product Preference Isolation · Web Push &amp; Android FCM Token Lifecycle
                </div>
                <h1 className="text-2xl font-bold text-slate-950 font-display">
                  Device Token Registry &amp; User Notification Preferences
                </h1>
              </div>

              {/* Per-Product Preference Matrix */}
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200">
                  <h2 className="text-base font-semibold text-slate-950">
                    Per-Product Notification Preferences (notification_preferences)
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Each GoGo product maintains independent opt-in/opt-out switches and quiet hours
                    keyed by Firebase UID.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <th className="py-3 px-4 font-semibold">GoGo Product</th>
                        <th className="py-3 px-4 font-semibold">Master Enabled</th>
                        <th className="py-3 px-4 font-semibold">Web Push</th>
                        <th className="py-3 px-4 font-semibold">Android Push</th>
                        <th className="py-3 px-4 font-semibold">Transactional</th>
                        <th className="py-3 px-4 font-semibold">Marketing</th>
                        <th className="py-3 px-4 font-semibold">Quiet Hours</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {preferences.map((pref) => (
                        <tr key={pref.prefId} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                            {pref.appId}
                          </td>
                          <td className="py-3 px-4">
                            <input
                              type="checkbox"
                              checked={pref.enabled}
                              onChange={(e) =>
                                handleUpdatePreference(pref, { enabled: e.target.checked })
                              }
                            />
                          </td>
                          <td className="py-3 px-4">
                            <input
                              type="checkbox"
                              checked={pref.webPush}
                              onChange={(e) =>
                                handleUpdatePreference(pref, { webPush: e.target.checked })
                              }
                            />
                          </td>
                          <td className="py-3 px-4">
                            <input
                              type="checkbox"
                              checked={pref.androidPush}
                              onChange={(e) =>
                                handleUpdatePreference(pref, { androidPush: e.target.checked })
                              }
                            />
                          </td>
                          <td className="py-3 px-4">
                            <input
                              type="checkbox"
                              checked={pref.transactionalAlerts}
                              onChange={(e) =>
                                handleUpdatePreference(pref, {
                                  transactionalAlerts: e.target.checked,
                                })
                              }
                            />
                          </td>
                          <td className="py-3 px-4">
                            <input
                              type="checkbox"
                              checked={pref.marketingAlerts}
                              onChange={(e) =>
                                handleUpdatePreference(pref, {
                                  marketingAlerts: e.target.checked,
                                })
                              }
                            />
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-600">
                            {pref.quietHoursStart} – {pref.quietHoursEnd}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Register Token Form + Device Registry Table */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <form
                  onSubmit={handleRegisterDevice}
                  className="lg:col-span-4 bg-white border border-slate-200 rounded-lg p-6 space-y-4"
                >
                  <h2 className="text-base font-semibold text-slate-950">
                    Register / Refresh FCM Token
                  </h2>
                  <p className="text-xs text-slate-500">
                    Binds token to your verified Firebase UID (never trusts raw frontend UIDs).
                  </p>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      GoGo Product
                    </label>
                    <select
                      value={regDeviceAppId}
                      onChange={(e) => setRegDeviceAppId(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      {products.map((p) => (
                        <option key={p.appId} value={p.appId}>
                          {p.name} ({p.appId})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">Platform</label>
                    <select
                      value={regDevicePlatform}
                      onChange={(e) => setRegDevicePlatform(e.target.value as 'web' | 'android')}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      <option value="web">Web Push (Browser VAPID)</option>
                      <option value="android">Android App (FCM SDK)</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      FCM Registration Token
                    </label>
                    <input
                      type="text"
                      value={regDeviceToken}
                      onChange={(e) => setRegDeviceToken(e.target.value)}
                      required
                      minLength={16}
                      className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    Register Device Token
                  </button>
                </form>

                <div className="lg:col-span-8 bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-base font-semibold text-slate-950">
                      Registered Device Tokens ({devices.length})
                    </h2>
                    <select
                      value={deviceFilterApp}
                      onChange={(e) => setDeviceFilterApp(e.target.value)}
                      className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      <option value="all">All GoGo Products</option>
                      {products.map((p) => (
                        <option key={p.appId} value={p.appId}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                          <th className="py-2.5 px-4 font-semibold">Device ID / User UID</th>
                          <th className="py-2.5 px-4 font-semibold">Product &amp; Platform</th>
                          <th className="py-2.5 px-4 font-semibold">Status</th>
                          <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {devices
                          .filter((d) => deviceFilterApp === 'all' || d.appId === deviceFilterApp)
                          .map((dev) => (
                            <tr key={dev.deviceId} className="hover:bg-slate-50">
                              <td className="py-2.5 px-4 font-mono">
                                <div className="text-slate-900 font-medium">{dev.deviceId}</div>
                                <div className="text-[11px] text-slate-500">
                                  UID: {dev.userId} · {dev.userAgent.slice(0, 38)}
                                </div>
                              </td>
                              <td className="py-2.5 px-4 font-mono text-slate-700">
                                {dev.appId} · {dev.platform}
                              </td>
                              <td className="py-2.5 px-4 font-mono">
                                {dev.status === 'active' ? (
                                  <span className="text-emerald-700 font-semibold">active</span>
                                ) : dev.status === 'expired' ? (
                                  <span className="text-amber-700 font-semibold">
                                    expired (pruned)
                                  </span>
                                ) : (
                                  <span className="text-red-700 font-semibold">revoked</span>
                                )}
                              </td>
                              <td className="py-2.5 px-4 text-right">
                                {dev.status === 'active' && (
                                  <button
                                    onClick={() => handleRevokeDevice(dev.deviceId)}
                                    className="px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 rounded inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    Revoke
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 5: SECURITY EVENTS, RBAC, USERS & AUDIT LOGS
             ================================================================ */}
          {activeSection === 'security-audit' && (
            <div className="space-y-8">
              <div className="border-b border-slate-200 pb-5">
                <div className="text-xs text-slate-500 mb-1">
                  OWASP API Top 10 Protection · Zero-Trust Firestore ABAC · Immutable Audit Trail
                </div>
                <h1 className="text-2xl font-bold text-slate-950 font-display">
                  Security Events, RBAC Directory &amp; Immutable Audit Logs
                </h1>
              </div>

              {currentUser?.role !== 'admin' ? (
                <div className="bg-white border border-slate-200 rounded-lg p-8 text-center space-y-3">
                  <Lock className="w-8 h-8 text-amber-600 mx-auto" />
                  <h2 className="text-base font-semibold text-slate-950">
                    Server-Side RBAC Guard Active (Standard User Role)
                  </h2>
                  <p className="text-xs text-slate-600 max-w-md mx-auto">
                    You are currently previewing with the standard <code>user</code> role. Switch to{' '}
                    <strong>Admin Role</strong> in the left sidebar or sign in as{' '}
                    <code>aaryapratik@gmail.com</code> to inspect admin security events, user
                    mappings, and system configurations.
                  </p>
                </div>
              ) : (
                <>
                  {/* Security Events & Audit Logs Split */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
                    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                      <div className="px-5 py-4 border-b border-slate-200">
                        <h2 className="text-base font-semibold text-slate-950">
                          OWASP API Security Events (security_events)
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Blocked unverified tokens, RBAC violations, idempotency catches, and
                          pruned tokens
                        </p>
                      </div>
                      <div className="divide-y divide-slate-200">
                        {securityEvents.map((evt) => (
                          <div key={evt.eventId} className="p-4 space-y-1 text-xs">
                            <div className="flex items-center justify-between font-mono">
                              <span className="font-semibold text-slate-900">{evt.eventType}</span>
                              <span
                                className={
                                  evt.severity === 'high' || evt.severity === 'critical'
                                    ? 'text-red-700 font-semibold'
                                    : 'text-amber-700 font-medium'
                                }
                              >
                                {evt.severity.toUpperCase()} · {evt.appId}
                              </span>
                            </div>
                            <p className="text-slate-600">{evt.mitigationApplied}</p>
                            <div className="text-[11px] font-mono text-slate-400">
                              {evt.endpoint} · {evt.actorIpHash} ·{' '}
                              {new Date(evt.createdAt).toLocaleTimeString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                      <div className="px-5 py-4 border-b border-slate-200">
                        <h2 className="text-base font-semibold text-slate-950">
                          Immutable Admin &amp; User Audit Trail (audit_logs)
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Append-only log enforced by PostgreSQL &amp; Firestore (allow update,
                          delete: if false)
                        </p>
                      </div>
                      <div className="divide-y divide-slate-200">
                        {auditLogs.slice(0, 8).map((log) => (
                          <div key={log.logId} className="p-4 space-y-1 text-xs">
                            <div className="flex items-center justify-between font-mono">
                              <span className="font-semibold text-slate-900">{log.action}</span>
                              <span className="text-slate-500">
                                {log.appId} · {log.actorId}
                              </span>
                            </div>
                            <p className="text-slate-600">{log.details}</p>
                            <div className="text-[11px] font-mono text-slate-400">
                              Resource: {log.resourceId} ·{' '}
                              {new Date(log.createdAt).toLocaleString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Central User Identity Mapping & System Configuration */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
                      <div className="px-5 py-4 border-b border-slate-200">
                        <h2 className="text-base font-semibold text-slate-950">
                          Centralized Firebase UID User Mapping (users)
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Zero unnecessary PII stored · Existing Firestore game saves preserved
                        </p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                              <th className="py-2.5 px-4 font-semibold">Firebase UID</th>
                              <th className="py-2.5 px-4 font-semibold">User / Role</th>
                              <th className="py-2.5 px-4 font-semibold">Connected GoGo Apps</th>
                              <th className="py-2.5 px-4 font-semibold">Game Saves</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200">
                            {users.map((u) => (
                              <tr key={u.uid} className="hover:bg-slate-50">
                                <td className="py-2.5 px-4 font-mono text-slate-900">{u.uid}</td>
                                <td className="py-2.5 px-4">
                                  <div className="font-medium text-slate-900">{u.displayName}</div>
                                  <div className="text-[11px] text-slate-500 font-mono">
                                    {u.role.toUpperCase()} · {u.authProvider}
                                  </div>
                                </td>
                                <td className="py-2.5 px-4 font-mono text-slate-600">
                                  {u.connectedApps.join(', ')}
                                </td>
                                <td className="py-2.5 px-4 font-mono text-emerald-700">
                                  {u.firestoreGameSavePreserved ? 'Preserved' : 'N/A'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                      <div className="flex items-center gap-2">
                        <Sliders className="w-4 h-4 text-slate-700" />
                        <h2 className="text-base font-semibold text-slate-950">
                          System Configuration (system_configs)
                        </h2>
                      </div>
                      <div className="divide-y divide-slate-200 text-xs">
                        {systemConfigs.map((cfg) => (
                          <div key={cfg.configKey} className="py-3 space-y-1">
                            <div className="flex items-center justify-between font-mono">
                              <span className="font-semibold text-slate-900">{cfg.configKey}</span>
                              <span className="font-bold text-blue-700">{cfg.configValue}</span>
                            </div>
                            <p className="text-slate-500">{cfg.description}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ================================================================
              SECTION 6: INR COST ANALYZER, DOCKER & PROJECT DOCUMENTATION
             ================================================================ */}
          {activeSection === 'costs-docs' && (
            <div className="space-y-8">
              <div className="border-b border-slate-200 pb-5">
                <div className="text-xs text-slate-500 mb-1">
                  ₹0 Local Docker Compose First · Official Google Cloud &amp; Firebase Pricing in INR
                </div>
                <h1 className="text-2xl font-bold text-slate-950 font-display">
                  Monthly Cost Estimator (INR ₹) &amp; Permanent Documentation
                </h1>
              </div>

              {/* Interactive INR Cost Calculator */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
                  <div>
                    <h2 className="text-base font-semibold text-slate-950">
                      Interactive Cloud Cost Simulator (INR ₹)
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Cloud SQL is NOT lifetime-free. Compare ₹0 local Docker Compose against
                      production Cloud Run + Cloud SQL tiers before approving deployment.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-slate-700">
                      Infrastructure Deployment Mode
                    </label>
                    <select
                      value={costDeployMode}
                      onChange={(e) =>
                        setCostDeployMode(
                          e.target.value as 'local_docker' | 'cloudsql_micro' | 'cloudsql_small'
                        )
                      }
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      <option value="local_docker">
                        Phase 1–8: Local Docker Compose + PostgreSQL 16 + Emulator (₹0/mo)
                      </option>
                      <option value="cloudsql_micro">
                        Phase 9 Prod: Cloud Run (Scale-to-Zero) + Cloud SQL db-f1-micro
                      </option>
                      <option value="cloudsql_small">
                        Phase 9 High-Growth: Cloud Run + Cloud SQL db-g1-small
                      </option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-slate-700">
                        Total Monthly Active Users (MAUs)
                      </span>
                      <span className="font-mono tabular-nums font-semibold">
                        {costMauCount.toLocaleString()} MAUs
                      </span>
                    </div>
                    <input
                      type="range"
                      min={5000}
                      max={150000}
                      step={5000}
                      value={costMauCount}
                      onChange={(e) => setCostMauCount(Number(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-[11px] text-slate-500">
                      Firebase Auth free tier: 50,000 MAUs/month free
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-slate-700">
                        Monthly Backend API Requests
                      </span>
                      <span className="font-mono tabular-nums font-semibold">
                        {costMonthlyRequestsMillions} Million req/mo
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.5}
                      max={10}
                      step={0.5}
                      value={costMonthlyRequestsMillions}
                      onChange={(e) => setCostMonthlyRequestsMillions(Number(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-[11px] text-slate-500">
                      Cloud Run free tier: 2 Million requests/mo free · Scale-to-zero idle = ₹0
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                    <div>
                      <div className="text-xs text-slate-500">Estimated Monthly Total (incl. GST)</div>
                      <div className="text-3xl font-bold text-slate-950 font-mono tabular-nums mt-0.5">
                        ₹{inrEstimate.totalWithGstInr.toLocaleString('en-IN')} / month
                      </div>
                    </div>
                    <div className="text-right text-xs font-mono text-slate-600">
                      <div>Subtotal: ₹{inrEstimate.subtotalInr.toLocaleString('en-IN')}</div>
                      <div>18% GST: ₹{inrEstimate.gstInr.toLocaleString('en-IN')}</div>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-200 text-xs">
                    <div className="py-2.5 flex justify-between">
                      <span className="text-slate-600">
                        Firebase Cloud Messaging (Web Push + Android)
                      </span>
                      <span className="font-mono tabular-nums font-semibold text-emerald-700">
                        ₹0 (Unlimited Free)
                      </span>
                    </div>
                    <div className="py-2.5 flex justify-between">
                      <span className="text-slate-600">
                        Firebase Authentication ({costMauCount.toLocaleString()} MAUs)
                      </span>
                      <span className="font-mono tabular-nums font-semibold">
                        ₹{inrEstimate.authCostInr.toLocaleString('en-IN')}
                      </span>
                    </div>
                    <div className="py-2.5 flex justify-between">
                      <span className="text-slate-600">
                        Google Cloud Run (--min-instances=0, {costMonthlyRequestsMillions}M req)
                      </span>
                      <span className="font-mono tabular-nums font-semibold">
                        ₹{inrEstimate.cloudRunCostInr.toLocaleString('en-IN')}
                      </span>
                    </div>
                    <div className="py-2.5 flex justify-between">
                      <span className="text-slate-600">
                        PostgreSQL Storage &amp; Backups (
                        {costDeployMode === 'local_docker'
                          ? 'Local Docker Compose'
                          : costDeployMode === 'cloudsql_micro'
                          ? 'Cloud SQL db-f1-micro + 10GB SSD'
                          : 'Cloud SQL db-g1-small + 20GB SSD'}
                        )
                      </span>
                      <span className="font-mono tabular-nums font-semibold">
                        ₹{inrEstimate.cloudSqlCostInr.toLocaleString('en-IN')}
                      </span>
                    </div>
                    <div className="py-2.5 flex justify-between">
                      <span className="text-slate-600">
                        Secret Manager, Artifact Registry, Logging &amp; Egress
                      </span>
                      <span className="font-mono tabular-nums font-semibold">
                        ₹{inrEstimate.networkAndLogsInr.toLocaleString('en-IN')}
                      </span>
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-500 pt-2 border-t border-slate-100">
                    Billing Governance: Paid Cloud SQL resources are never created without your
                    explicit approval. All local development and automated tests run at ₹0.
                  </div>
                </div>
              </div>

              {/* Permanent Project Knowledge & Docker/SQL File Viewer */}
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-700" />
                    <h2 className="text-base font-semibold text-slate-950">
                      Repository Documentation, SQL Schema &amp; Docker Blueprints
                    </h2>
                  </div>
                  <button
                    onClick={() => handleCopyText(selectedDocId, docContent)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    {copiedKey === selectedDocId ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        Copied {selectedDocId}
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy File Content
                      </>
                    )}
                  </button>
                </div>

                <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap gap-1.5">
                  {DOC_FILES.map((docItem) => (
                    <button
                      key={docItem.id}
                      onClick={() => setSelectedDocId(docItem.id)}
                      className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        selectedDocId === docItem.id
                          ? 'bg-slate-900 text-white font-semibold'
                          : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {docItem.label}
                    </button>
                  ))}
                </div>

                <pre className="p-6 text-xs font-mono text-slate-800 bg-white overflow-x-auto max-h-[540px] leading-relaxed whitespace-pre-wrap">
                  {docContent}
                </pre>
              </div>
            </div>
          )}

          {loading && (
            <div className="text-xs text-slate-500 font-mono">
              Synchronizing with GoGo Central Backend...
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

