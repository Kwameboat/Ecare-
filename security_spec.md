# Security Specification: eCare GH AI

## 1. Data Invariants
- A user document must have a `creditBalance` of at least 0.
- A user can only access their own profile, sessions, messages, and transactions.
- Transactions can only be created by the system (admin).
- Appointments can be created by users but only for themselves.
- Admins have full read/write access to all collections for management.
- `paystackAuth` is a system-only field that users cannot modify.

## 2. Global Safety Net
- Default deny: `match /{document=**} { allow read, write: if false; }`

## 3. Interaction Collections
- **Users**: Secure profile data, balance, and settings.
- **Transactions**: Permanent financial log (User: Read-only, Admin: Create).
- **Sessions/Messages**: User chat history.
- **Doctors**: Public directory.
- **Appointments**: Relational data linking users and doctors.
- **Notifications**: User-specific alerts.
- **Settings**: System configurations.

## 4. The "Dirty Dozen" Payloads (Denial Tests)

1. **Identity Spoofing**: User A attempts to read User B's profile.
2. **Balance Injection**: User attempts to create a profile with 1,000,000 credits.
3. **Admin Escalation**: User attempts to update their email to match the admin email.
4. **Transaction Forgery**: User attempts to create a "purchase" transaction for themselves.
5. **PII Leak**: Unauthenticated user attempts to list all users.
6. **Resource Poisoning**: User attempts to create a message with 10MB of text.
7. **Cross-Session Access**: User A attempts to read User B's chat session.
8. **Auth Hijacking**: User attempts to modify their `paystackAuth` data.
9. **State Shortcutting**: User attempts to change an appointment status from 'pending' to 'completed'.
10. **Shadow Field update**: User attempts to add `isVerified: true` to their user document.
11. **Negative Credits**: User attempts to deduct credits resulting in a negative balance.
12. **System Config Tampering**: User attempts to update `settings/paystack`.

## 5. Conflict Report (Red Team Audit)

| Collection | Identity Spoofing | State Shortcutting | Resource Poisoning |
| :--- | :---: | :---: | :---: |
| users | BLOCKED (isOwner) | BLOCKED (hasOnly) | BLOCKED (isValidUser) |
| transactions | BLOCKED (isServer) | BLOCKED (No Update) | BLOCKED (No User Create) |
| sessions | BLOCKED (isOwner) | BLOCKED (hasOnly) | BLOCKED (isValidId) |
| messages | BLOCKED (isOwner) | BLOCKED (No Update) | BLOCKED (size limit) |
| appointments | BLOCKED (resource) | BLOCKED (hasOnly) | BLOCKED (isValidId) |
| settings | BLOCKED (isAdmin) | BLOCKED (isAdmin) | BLOCKED (isAdmin) |

## 6. Test Runner (`firestore.rules.test.ts`)
(To be implemented if testing environment is setup, but logic will be verified manually via Red Team Audit).
