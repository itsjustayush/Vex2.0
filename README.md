# Vex

Vex is a calm, colorful writing workspace prototype for notes, Markdown, LaTeX snippets, and endless moodboards. The current build intentionally keeps authentication paused while preserving the original Firebase and auth foundations for a later phase.

## Prototype features

The root experience is a redesigned Vex landing page with the live workspace embedded in the hero. The workspace includes a collapsible sidebar, a full-screen writing surface, ruled single and double pages, plain pages, light and dense dotted pages, light/dark/zen themes, a floating tactile keyboard with sound effects and mute control, Markdown-style formatting helpers, Markdown export, and a draggable moodboard canvas with sticky notes and image uploads.

Drafts persist in `localStorage` immediately. The client now uses the supplied mechanical keyboard sound pack (`static/sound.ogg` plus `static/sound-config.json`) and maps physical `KeyboardEvent.code` values to the visible keys in real time. Firebase Google sign-in and passwordless email confirmation-link sign-in are available from the in-app Sign in modal. After sending email, Vex opens a dedicated six-digit verification screen with resend and change-email actions, styled as a compact code workspace. Enable **Google** and **Email link** under Firebase Console → Authentication → Sign-in method, and add the deployed hostname under Authentication → Settings → Authorized domains.

The client also detects the existing Firebase configuration and writes to the existing `files` collection when a Firebase-authenticated user is present. Firebase Web Auth does not natively send numeric email OTP codes; this prototype uses Firebase’s supported one-time email link flow. A numeric OTP would require a server-side email provider and verification endpoint. The original login and server auth code remains preserved for later use.

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
| `firestore.rules` | Existing authenticated Firestore ownership rules. |
| `templates/login.html` and `templates/callback.html` | Preserved auth templates, intentionally not linked in the prototype. |

## Next implementation phase

For true cross-device sync for signed-out users, re-enable an identity flow or configure Firebase Anonymous Authentication. The current adapter is deliberately safe: it never attempts to create a shared anonymous identity, so unauthenticated sessions fall back to a device-local draft.
