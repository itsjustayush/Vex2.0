# Vex

> **Created by Ayush Bhattacharya** · [GitHub profile](https://github.com/itsjustayush) · [Vex repository](https://github.com/itsjustayush/Vex2.0) · [info.cometlabs@gmail.com](mailto:info.cometlabs@gmail.com)
>
> Vex’s tactile keyboard direction and visual starting point were inspired by [keythm.aayushbharti.in](https://keythm.aayushbharti.in/).

Vex is a calm, colorful writing workspace prototype for notes, Markdown, LaTeX snippets, and endless moodboards. The current build intentionally keeps authentication paused while preserving the original Firebase and auth foundations for a later phase.

## Prototype features

The root experience is a redesigned Vex landing page with the live workspace embedded in the hero. The workspace includes a collapsible sidebar, a full-screen writing surface, ruled single and double pages, plain pages, light and dense dotted pages, light/dark/zen themes, a floating tactile keyboard with sound effects and mute control, Markdown-style formatting helpers, Markdown export, and a draggable moodboard canvas with sticky notes and image uploads.

Guests use an in-memory workspace and saved data is written only after authentication. The client uses the supplied mechanical keyboard sound pack (`static/sound.ogg` plus `static/sound-config.json`) and maps physical `KeyboardEvent.code` values to the visible keys in real time. Firebase Google sign-in and Resend-backed six-digit email OTP sign-in are available from the in-app Sign in modal. After submitting an email, Vex opens a dedicated branded verification screen with resend and change-email actions. Enable **Google** in Firebase Authentication, add the deployed hostname under Authorized domains, and configure the Resend and Firebase Admin variables described below.

The client detects the existing Firebase configuration and writes to the authenticated user’s private Firestore space. The original Firebase email-link helper remains preserved for backwards compatibility with previously issued links, but new email sign-ins use the server-side Resend OTP flow.

## Branded email OTP setup

Vex’s six-digit email verification uses a server-side transactional email service rather than Firebase’s link-only browser flow. The recommended provider is [Resend](https://resend.com/docs/dashboard/api-keys/introduction), which requires a Resend account, a verified sending domain with its DNS records, an API key stored as `RESEND_API_KEY`, and a sender such as `Vex <auth@your-verified-domain.example>` in `RESEND_FROM`. Do not put the Resend key in browser JavaScript, Git, `.env.example`, screenshots, or chat. The key previously pasted during setup must be revoked and replaced.

The backend also requires Firebase Admin credentials in `FIREBASE_SERVICE_ACCOUNT_KEY` so a verified OTP can create or sign in a Firebase user and issue a Firebase custom token. Firestore stores only a hashed OTP challenge under the server-only `otp_challenges` collection; the browser cannot read or write those documents. Set `OTP_SECRET`, `OTP_TTL_SECONDS`, `OTP_RESEND_COOLDOWN_SECONDS`, and `OTP_MAX_ATTEMPTS` in the deployment secret store. The full variable list is in `.env.example`.

The minimum production services are therefore Resend for delivery, a verified domain and DNS provider for sender authentication, Firebase Authentication for the user identity, Firebase Admin SDK credentials for custom-token sign-in, and Firestore for short-lived hashed challenge records. A deployment secret manager is required to hold these credentials securely.

The email template is defined in `email_templates.py` and includes the Vex mark, six-digit code, expiry, security notice, and Ayush Bhattacharya attribution. The OTP API is exposed through `/api/auth/request-otp` and `/api/auth/verify-otp`.

## Sharing and exports

From a writing page, use **Share** for the browser’s native share sheet where available, or copy the note to the clipboard as a fallback. **Export** provides Markdown, plain-text `.txt`, and print-to-PDF output. The Google Docs handoff copies the note and opens `docs.new` so it can be pasted into a new document. A direct Google Docs API write is intentionally not enabled because it requires a user-authorized Google Workspace integration.

## SEO and discoverability

The public landing page includes a deployment-safe canonical URL, descriptive title and meta description, robots directives, Open Graph tags, Twitter card tags, JSON-LD WebApplication structured data, creator attribution, a branded social preview, root `robots.txt`, and `sitemap.xml`. Private workspace, auth, dashboard, settings, status, docs, and API routes are excluded from the crawl policy. Set `VEX_SITE_URL` in production when the public hostname is known; otherwise the Flask routes derive it from the incoming request origin.

## Run locally

```bash
python3 -m pip install -r requirements.txt
python3 app.py
```

Then open `http://127.0.0.1:3000/`.

## Essential structure

| Path | Purpose |
| --- | --- |
| `app.py` | Preserved Flask entrypoint, Firebase configuration, legacy API/auth foundations, and static page serving. |
| `templates/index.html` | Minimal HTML shell for the prototype. |
| `static/app.js` | Landing page, editor, keyboard, themes, persistence, Firebase sync adapter, and moodboard interactions. |
| `static/styles.css` | Visual system, responsive layout, page textures, keyboard treatment, auth modal, and theme palettes. |
| `static/sound.ogg` | Supplied CherryMX-style sound pack used for keydown playback. |
| `static/sound-config.json` | Sample offsets used to play the matching key segment. |
| `firebase-applet-config.json` | Existing Firebase client configuration. |
| `firestore.rules` | Authenticated per-user Firestore ownership rules for pages, boards, items, settings, and legacy collections. |
| `storage.rules` | Authenticated per-user Firebase Storage rules for moodboard media. |
| `templates/login.html` and `templates/callback.html` | Preserved auth templates, intentionally not linked in the prototype. |

## Persistence and storage model

Vex starts every unauthenticated visitor in an in-memory guest session. Guests can use the editor, keyboard, themes, and moodboard normally, but the app does not read or write the workspace to `localStorage`, Firebase, or the server. The guest status is shown as `guest · not saved`, with a visible sign-in-to-save action. After Google or email authentication, the current in-memory workspace is hydrated from, or promoted into, the authenticated user’s private Firestore space.

The scalable schema is rooted at the Firebase Auth UID: `users/{uid}` stores profile metadata, `users/{uid}/pages/{pageId}` stores page documents, `users/{uid}/boards/{boardId}` stores board metadata, `users/{uid}/boards/{boardId}/items/{itemId}` stores individual moodboard items, and `users/{uid}/settings/{settingId}` stores preferences. Firestore rules allow access only when `request.auth.uid` matches the `{uid}` path segment. Batched writes keep page, board, item, and settings updates efficient while limiting a board sync to the first 450 items under Firestore’s batch limit. Large moodboard images are uploaded to `users/{uid}/moodboard/{fileName}` in Firebase Storage, with only their download URL and metadata kept in Firestore.

## Next implementation phase

Guest sessions are intentionally non-persistent. Cross-device sync is available only after the user signs in or signs up, which keeps every saved workspace tied to a verified Firebase Auth UID.
