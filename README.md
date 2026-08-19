# Vex

Vex is a calm, colorful writing workspace prototype for notes, Markdown, LaTeX snippets, and endless moodboards. The current build intentionally keeps authentication paused while preserving the original Firebase and auth foundations for a later phase.

## Prototype features

The root experience is a redesigned Vex landing page with the live workspace embedded in the hero. The workspace includes a collapsible sidebar, a full-screen writing surface, ruled single and double pages, plain pages, light and dense dotted pages, light/dark/zen themes, a floating tactile keyboard with sound effects and mute control, Markdown-style formatting helpers, Markdown export, and a draggable moodboard canvas with sticky notes and image uploads.

Drafts persist in `localStorage` immediately. The client also detects the existing Firebase configuration and will write to the existing `files` collection when a Firebase-authenticated user is already present; the original login and server auth code remains available but is not linked from the prototype.

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
| `static/styles.css` | Visual system, responsive layout, page textures, keyboard treatment, and theme palettes. |
| `firebase-applet-config.json` | Existing Firebase client configuration. |
| `firestore.rules` | Existing authenticated Firestore ownership rules. |
| `templates/login.html` and `templates/callback.html` | Preserved auth templates, intentionally not linked in the prototype. |

## Next implementation phase

For true cross-device sync for signed-out users, re-enable an identity flow or configure Firebase Anonymous Authentication. The current adapter is deliberately safe: it never attempts to create a shared anonymous identity, so the prototype falls back to a device-local draft when auth is paused.
