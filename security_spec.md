# GoGo Central Backend — Security Specification (Phase 0 TDD)

## 1. Data Invariants & Relational Ownership Model

1. **Master Source of Truth**:
   - **Identity**: `request.auth.uid` (verified Firebase Authentication UID with `request.auth.token.email_verified == true`).
   - **Admin Directory**: `/admins/{adminId}` coupled with bootstrapped root admin email `aaryapratik@gmail.com` (`request.auth.token.email == 'aaryapratik@gmail.com' && request.auth.token.email_verified == true`).
   - **GoGo Product Catalog**: `/apps/{appId}` represents the 5 canonical GoGo products (`gogocompany-in`, `sarkari-sarthi`, `pika-news`, `arrow-out`, `crystal-quest`).
2. **Collection Invariants**:
   - `/users/{userId}`: Document ID MUST equal `uid` and `request.auth.uid`. Non-admin users can only create their profile with `role == 'user'` and cannot escalate privileges on update.
   - `/admins/{adminId}`: Strictly read/write restricted to verified admins (`isAdmin()`).
   - `/apps/{appId}`: Readable by authenticated verified users; writable strictly by verified admins (`isAdmin()`).
   - `/devices/{deviceId}`: Every device registration (`fcmToken`) MUST belong to `request.auth.uid` (`userId == request.auth.uid`) and reference an existing `/apps/$(incoming().appId)` document (`exists(...)`). List queries are strictly bounded by `resource.data.userId == request.auth.uid || isAdmin()`.
   - `/preferences/{prefId}`: Every notification preference document MUST belong to `request.auth.uid` (`userId == request.auth.uid`) and reference an existing `/apps/$(incoming().appId)` document.
   - `/notifications/{notificationId}`: Only verified admins (`isAdmin()`) can create or update FCM broadcast/targeted campaigns, and `authorId` MUST equal `request.auth.uid`.
   - `/auditLogs/{logId}`: Append-only immutable security audit logs. Any authenticated verified user can create an audit log where `actorId == request.auth.uid` and `createdAt == request.time`, and only verified admins (`isAdmin()`) can read/list audit logs. No updates or deletes are permitted (`allow update, delete: if false`).

---

## 2. The "Dirty Dozen" Adversarial Payloads

| # | Attack Vector | Target Path | Malicious Payload | Expected Result |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Privilege Escalation (Self-Admin on Create)** | `/users/attacker_1` | `{ uid: "attacker_1", displayName: "Attacker", role: "admin", createdAt: NOW, updatedAt: NOW }` | `PERMISSION_DENIED` |
| 2 | **Shadow Field Injection (Ghost Key)** | `/users/user_1` | `{ uid: "user_1", displayName: "User", role: "user", isSuperAdmin: true, createdAt: NOW, updatedAt: NOW }` | `PERMISSION_DENIED` |
| 3 | **Email Spoofing (Unverified Admin Email)** | `/apps/pika-news` | Auth token `{ email: "aaryapratik@gmail.com", email_verified: false }` writing app config | `PERMISSION_DENIED` |
| 4 | **ID Poisoning (1.5KB Document ID)** | `/devices/<1500_char_string>` | Valid device body with oversized path variable | `PERMISSION_DENIED` |
| 5 | **Orphaned App Reference** | `/devices/dev_1` | `{ deviceId: "dev_1", userId: "user_1", appId: "non-existent-app", ... }` | `PERMISSION_DENIED` |
| 6 | **Cross-User Token Hijack** | `/devices/dev_victim` | User `attacker_1` registering `{ userId: "victim_uid", ... }` | `PERMISSION_DENIED` |
| 7 | **Unbounded Query Scraping (Blanket List)** | `/devices` | Authenticated non-admin attempting `getDocs(collection(db, 'devices'))` without `where('userId', '==', uid)` | `PERMISSION_DENIED` |
| 8 | **Timestamp Forgery (Backdated Audit Log)** | `/auditLogs/log_1` | `{ ..., createdAt: Timestamp.fromMillis(1600000000000) }` (`createdAt != request.time`) | `PERMISSION_DENIED` |
| 9 | **Immutable Field Mutation** | `/preferences/pref_1` | Updating `userId` or `appId` or `createdAt` on an existing preference | `PERMISSION_DENIED` |
| 10 | **Value Poisoning on Update** | `/preferences/pref_1` | Updating allowed key `quietHoursStart` with a 500-char string or integer `12345` | `PERMISSION_DENIED` |
| 11 | **Unauthorized Broadcast Dispatch** | `/notifications/notif_1` | Non-admin user creating an FCM broadcast campaign | `PERMISSION_DENIED` |
| 12 | **Audit Log Tampering / Deletion** | `/auditLogs/log_1` | Admin or user attempting `updateDoc` or `deleteDoc` on an existing audit log | `PERMISSION_DENIED` |

---

## 3. Red Team Audit Conflict Report

- **Identity Spoofing**: Blocked across all collections (`incoming().uid == request.auth.uid`, `incoming().userId == request.auth.uid`, `incoming().authorId == request.auth.uid`, `incoming().actorId == request.auth.uid`).
- **State Shortcutting / Terminal State Locking**: In `/notifications/{notificationId}`, once `existing().status == 'delivered'`, standard non-admin updates are locked (`existing().status != 'delivered' || isAdmin()`).
- **Resource Poisoning**: Every string field has an explicit `.size() <= MAX` guard matching `firebase-blueprint.json` verbatim, and every ID path parameter is validated via `isValidId()`.
- **Value Poisoning**: Every `allow update` block begins with `isValid[Entity](incoming())` before evaluating `affectedKeys().hasOnly(...)`.
