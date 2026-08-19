# Vex

> **Created by Ayush Bhattacharya** · [GitHub profile](https://github.com/itsjustayush) · [Vex repository](https://github.com/itsjustayush/Vex2.0) · [info.cometlabs@gmail.com](mailto:info.cometlabs@gmail.com)
>
> Vex’s tactile keyboard direction and visual starting point were inspired by [keythm.aayushbharti.in](https://keythm.aayushbharti.in/).

Vex is a calm, colorful writing workspace prototype for notes, Markdown, LaTeX snippets, and endless moodboards. The current build intentionally keeps authentication paused while preserving the original Firebase and auth foundations for a later phase.

## Prototype features

The root experience is a redesigned Vex landing page with the live workspace embedded in the hero. The workspace includes a collapsible sidebar, a full-screen writing surface, ruled single and double pages, plain pages, light and dense dotted pages, light/dark/zen themes, a floating tactile keyboard with sound effects and mute control, Markdown-style formatting helpers, Markdown export, and a draggable moodboard canvas with sticky notes and image uploads.

Guests use an in-memory workspace and saved data is written only after authentication. The client uses the supplied mechanical keyboard sound pack (`static/sound.ogg` plus `static/sound-config.json`) and maps physical `KeyboardEvent.code` values to the visible keys in real time. Firebase Google sign-in and Resend-backed six-digit email OTP sign-in are available from the in-app Sign in modal. After submitting an email, Vex opens a dedicated branded verification screen with resend and change-email actions. Enable **Google** in Firebase Authentication, add the deployed hostname under Authorized domains, and configure the Resend and Firebase Admin variables described below.

The client detects the existing Firebase configuration for authentication and media storage. Durable notes, moodboards, board items, preferences, and typing statistics are stored in the Vex Supabase project through authenticated Flask endpoints that verify the Firebase ID token and scope every query by the Firebase Auth UID. The original Firebase email-link helper remains preserved for backwards compatibility with previously issued links, but new email sign-ins use the server-side Resend OTP flow.

## Branded email OTP setup

Vex’s six-digit email verification uses a server-side transactional email service rather than Firebase’s link-only browser flow. The recommended provider is [Resend](https://resend.com/docs/dashboard/api-keys/introduction), which requires a Resend account, a verified sending domain with its DNS records, an API key stored as `RESEND_API_KEY`, and a sender such as `Vex <auth@your-verified-domain.example>` in `RESEND_FROM`. Do not put the Resend key in browser JavaScript, Git, `.env.example`, screenshots, or chat. The key previously pasted during setup must be revoked and replaced.

The backend also requires Firebase Admin credentials in `FIREBASE_SERVICE_ACCOUNT_KEY` so a verified OTP can create or sign in a Firebase user and issue a Firebase custom token. Firestore stores only a hashed OTP challenge under the server-only `otp_challenges` collection; the browser cannot read or write those documents. Set `OTP_SECRET`, `OTP_TTL_SECONDS`, `OTP_RESEND_COOLDOWN_SECONDS`, and `OTP_MAX_ATTEMPTS` in the deployment secret store. The full variable list is in `.env.example`.

The minimum production services are therefore Resend for delivery, a verified domain and DNS provider for sender authentication, Firebase Authentication for the user identity, Firebase Admin SDK credentials for custom-token sign-in, and Firestore for short-lived hashed challenge records. A deployment secret manager is required to hold these credentials securely. Gmail is available in the connected workspace for interactive, user-confirmed messages, but it is not used as the app’s unattended OTP backend; reliable per-user delivery requires a server-side provider such as Resend with a secret stored in the deployment environment.

The email template is defined in `email_templates.py` and includes the Vex mark, six-digit code, expiry, security notice, and Ayush Bhattacharya attribution. The OTP API is exposed through `/api/auth/request-otp` and `/api/auth/verify-otp`.

The **Enhance Typing** tab provides typewriter-style exercises, a progressive prompt animation, live correctness feedback, WPM and accuracy calculations, exercise selection, and a personal streak. Typing progress is stored under `users/{uid}/typing/stats`, separate from every other account. Guests can practice in memory, but their progress is not persisted until authentication.

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
| `app.py` | Preserved Flask entrypoint, Firebase configuration, authenticated Supabase persistence bridge, legacy API/auth foundations, and static page serving. |
| `templates/index.html` | Minimal HTML shell for the prototype. |
| `static/app.js` | Landing page, editor, keyboard, themes, Supabase/Firebase persistence adapters, and moodboard interactions. |
| `static/styles.css` | Visual system, responsive layout, page textures, keyboard treatment, auth modal, and theme palettes. |
| `static/sound.ogg` | Supplied CherryMX-style sound pack used for keydown playback. |
| `static/sound-config.json` | Sample offsets used to play the matching key segment. |
| `firebase-applet-config.json` | Existing Firebase client configuration. |
| `firestore.rules` | Authenticated per-user Firestore ownership rules for pages, boards, items, settings, and legacy collections. |
| `storage.rules` | Authenticated per-user Firebase Storage rules for moodboard media. |
| `templates/login.html` and `templates/callback.html` | Preserved auth templates, intentionally not linked in the prototype. |

## Persistence and storage model

Vex starts every unauthenticated visitor in an in-memory guest session. Guests can use the editor, keyboard, themes, and moodboard normally, but the app does not read or write the workspace to `localStorage`, Firebase, or the server. The guest status is shown as `guest · not saved`, with a visible sign-in-to-save action. After Google or email authentication, the current in-memory workspace is hydrated from, or promoted into, the authenticated user’s private Supabase space through the Firebase-verified Flask bridge.

The durable Supabase schema is rooted at the Firebase Auth UID: `vex_pages` stores note documents, `vex_boards` stores board metadata, `vex_board_items` stores individual moodboard pieces, `vex_settings` stores preferences, and `vex_typing_stats` stores per-user typing statistics. The Flask bridge verifies the Firebase ID token before querying or upserting rows and always applies the authenticated UID filter. Row-level security is enabled on all Vex tables. Firebase Storage remains responsible for moodboard media under `users/{uid}/moodboard/{fileName}`. Set `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY` in Vercel; never expose the service-role key to browser code.

## Deployment persistence variables

In addition to the Firebase and Resend variables, production requires `SUPABASE_URL=https://qdsdjgfvimuvdujxouab.supabase.co` and a server-only `SUPABASE_SERVICE_ROLE_KEY` from the Vex Supabase project. The browser receives only the project URL and never receives the service-role key. Cross-device sync is available only after the user signs in or signs up, which keeps every saved workspace tied to a verified Firebase Auth UID.

## Next implementation phase

Guest sessions are intentionally non-persistent. Cross-device sync is available only after the user signs in or signs up, which keeps every saved workspace tied to a verified Firebase Auth UID.
