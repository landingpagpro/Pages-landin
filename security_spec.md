# Security Specification — Landing Page Pro Firestore Rules

## 1. Data Invariants
1. Global default-deny catch-all (`/{document=**}`) blocks all unmapped collections and operations.
2. Private write-only lock records at `/page_locks/{slug}` store `{ secret, nonce, nonceProof, createdAt, updatedAt }` with `allow read, list, delete: if false`.
3. On `/page_locks/{slug}` update, the client MUST supply a strictly different `nonce` and a valid SHA-256 `nonceProof` bytes digest matching `hashing.sha256((incoming().nonce + ':' + existing().secret).toUtf8())`, while `secret` and `createdAt` remain immutable.
4. Every published landing page at `/published_pages/{slug}` MUST satisfy `isValidSlugId(slug)` (`^[a-z0-9-]+$`, length 3..80) and `slug == incoming().slug`.
5. Every create and update on `/published_pages/{slug}` MUST happen inside the same atomic `writeBatch` as `/page_locks/{slug}` (`getAfter(/databases/$(database)/documents/page_locks/$(slug)).data.updatedAt == request.time`), preventing unowned hijacking without requiring Google sign-in.
6. Public visitors may fetch a single known page (`allow get` by exact `slug`), while `allow list` and `allow delete` are denied to prevent scraping or unauthorized deletion.
7. Every string, list, and map field enforces strict key allowlists and explicit size/type/range bounds.
8. Optional footer customization (`footerConfig`) enforces exact 12-key allowlists, boolean visibility toggles, bounded text fields (`<= 120` / `<= 2000`), `themeMode in ['auto', 'accent', 'custom']`, and strict hex color patterns.

## 2. Adversarial Payloads (Expected: PERMISSION_DENIED)
1. **Direct Page Create Without Atomic Lock**: Writing `/published_pages/{slug}` outside the `page_locks/{slug}` batch (`getAfter` mismatch).
2. **Reading Page Lock Secrets**: Any client attempting `get` or `list` on `/page_locks/{slug}`.
3. **Hijacking Page Update Without Secret**: Updating `/published_pages/{slug}` or `/page_locks/{slug}` with wrong `nonceProof`.
4. **Nonce Replay Attack**: Reusing the previous `nonce` on `/page_locks/{slug}` update.
5. **Secret Tampering**: Altering `secret` on `/page_locks/{slug}` update.
6. **Slug Poisoning (Path ID)**: Writing to `/published_pages/` with invalid characters (`UPPERCASE!@#`) or >80 chars.
7. **Slug Mismatch**: Writing document with `slug: "other"` into `/published_pages/test-slug`.
8. **Shadow Field Injection**: Adding `"isAdmin": true` or `"featured": true` on create or update.
9. **Immutable Timestamp Tampering**: Forging `createdAt` or altering `createdAt` during update.
10. **Oversized Array / Denial-of-Wallet**: Submitting `images` > 6 items, `reviews` > 20 items, or oversized strings.
11. **Blanket List Scraping**: Calling `getDocs(collection(db, "published_pages"))` or `getDocs(collection(db, "page_locks"))`.
12. **Unauthorized Page Delete**: Attempting `deleteDoc` on `/published_pages/{slug}` or `/page_locks/{slug}`.
