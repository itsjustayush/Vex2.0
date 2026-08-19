# Contributing to Vex

Thank you for helping improve Vex. Vex is a calm writing and moodboard workspace created by Ayush Bhattacharya. Before opening a pull request, please read the project documentation and review the existing interaction patterns.

## Development setup

Run the Flask prototype locally:

```bash
python3 -m pip install -r requirements.txt
python3 app.py
```

The default development URL is `http://127.0.0.1:3000/`.

## Before submitting a change

Please keep the interface minimal, accessible, responsive, and keyboard-friendly. Preserve the light, dark, and zen themes, the full-screen editor surface, the real-time keyboard behavior, and the guest-mode privacy rule: unauthenticated workspace data must not be persisted.

Run the following checks before submitting a pull request:

```bash
node --check static/app.js
python3 -m py_compile app.py
python3 -m json.tool metadata.json >/dev/null
rm -rf __pycache__
git diff --check
```

If you change Firebase behavior, review both `firestore.rules` and `storage.rules`. Never commit service-account credentials, API keys, user data, or private exports.

## Pull requests

Use a descriptive title, explain the user-facing outcome, list the verification steps you ran, and include screenshots or a short recording for visual or interaction changes. Keep pull requests focused and avoid unrelated formatting churn.

## Inspiration and attribution

The tactile keyboard direction was inspired by [keythm.aayushbharti.in](https://keythm.aayushbharti.in/). Vex is an independent project by [Ayush Bhattacharya](https://github.com/itsjustayush).
