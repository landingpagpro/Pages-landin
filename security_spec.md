# Security Specification — Landing Page Pro Firestore Rules

## 1. Data Invariants
1. Global default-deny catch-all (`/{document=**}`) blocks all unmapped collections and operations.
2. Every published landing page at `/published_pages/{slug}` MUST satisfy `isValidId(slug)` (`^[a-z0-9-]+$`, length 3..80) and `slug == incoming().slug`.
3. Only authenticated users with verified emails (`request.auth != null && request.auth.token.email_verified == true`) can create, update, delete, or list their own `/published_pages/{slug}` documents.
4. `ownerId` MUST strictly equal `request.auth.uid` on create and remain immutable on update.
5. `createdAt` MUST equal `request.time` on create and remain immutable on update; `updatedAt` MUST equal `request.time` on both create and update.
6. Public visitors may fetch a single known page (`allow get` by exact `slug`), while `allow list` strictly requires authentication and `resource.data.ownerId == request.auth.uid` to prevent scraping/enumeration.
7. Every string, list, and map field enforces strict key allowlists (`hasAll`/`hasOnly` on create, `affectedKeys().hasOnly(...)` on update) and explicit size/type/range bounds.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated Create**: Create `/published_pages/test-slug` with `request.auth == null`.
2. **Unverified Email Write**: Authenticated user with `email_verified: false` attempting `create` or `update`.
3. **Owner Spoofing**: Authenticated user A setting `ownerId: "user-B-uid"` on create.
4. **Cross-Owner Update Hijack**: User B updating a page owned by User A (`existing().ownerId == "user-A"`).
5. **Cross-Owner Delete**: User B deleting a page owned by User A.
6. **Owner Reassignment**: User A updating `ownerId` to another UID.
7. **Slug Poisoning (Path ID)**: Writing to `/published_pages/` with a 150-char or invalid-character document ID (`UPPERCASE!@#`).
8. **Slug Mismatch**: Writing document with `slug: "other"` into `/published_pages/test-slug`.
9. **Shadow Field Injection**: Adding `"isAdmin": true` or `"featured": true` on create or update.
10. **Immutable Timestamp Tampering**: Client forging `createdAt` or `updatedAt` to a past timestamp instead of `request.time`, or altering `createdAt` during update.
11. **Oversized Array / Denial-of-Wallet**: Submitting `images` with 7+ items or `reviews` with 21+ items or a string exceeding maxLength.
12. **Blanket List Scraping**: Calling `getDocs(collection(db, "published_pages"))` without filtering by `where("ownerId", "==", auth.currentUser.uid)`.
