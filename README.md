# Vex

> **Created by Ayush Bhattacharya** · [GitHub profile](https://github.com/itsjustayush) · [Vex repository](https://github.com/itsjustayush/Vex2.0) · [info.cometlabs@gmail.com](mailto:info.cometlabs@gmail.com)
>
> Vex’s tactile keyboard direction and visual starting point were inspired by [keythm.aayushbharti.in](https://keythm.aayushbharti.in/).

Vex is a calm, colorful writing workspace prototype for notes, Markdown, LaTeX snippets, and endless moodboards. The current build intentionally keeps authentication paused while preserving the original Firebase and auth foundations for a later phase.

## Prototype features

The root experience is a redesigned Vex landing page with the live workspace embedded in the hero. The workspace includes a collapsible sidebar, a full-screen writing surface, ruled single and double pages, plain pages, light and dense dotted pages, light/dark/zen themes, a floating tactile keyboard with sound effects and mute control, Markdown-style formatting helpers, Markdown export, and a draggable moodboard canvas with sticky notes and image uploads.

Guests use an in-memory workspace and saved data is written only after authentication. The client uses the supplied mechanical keyboard sound pack (`static/sound.ogg` plus `static/sound-config.json`) and maps physical `KeyboardEvent.code` values to the visible keys in real time. Firebase Google sign-in and passwordless email confirmation-link sign-in are available from the in-app Sign in modal. After sending email, Vex opens a dedicated six-digit verification screen with resend and change-email actions, styled as a compact code workspace. Enable **Google** and **Email link** under Firebase Console → Authentication → Sign-in method, and add the deployed hostname under Authentication → Settings → Authorized domains.

The client also detects the existing Firebase configuration and writes to the existing `files` collection when a Firebase-authenticated user is present. Firebase Web Auth does not natively send numeric email OTP codes; this prototype uses Firebase’s supported one-time email link flow. A numeric OTP would require a server-side email provider and verification endpoint. The original login and server auth code remains preserved for later use.

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
