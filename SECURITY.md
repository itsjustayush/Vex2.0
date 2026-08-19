# Security Policy

## Supported versions

The `main` branch is the actively maintained version of Vex.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Email [info.cometlabs@gmail.com](mailto:info.cometlabs@gmail.com) with the repository version or commit, a description of the issue, reproduction steps, and the potential impact. Do not include real user data, credentials, service-account keys, or private Firebase configuration in the report.

We will acknowledge reports as soon as practical, investigate the issue, and coordinate a fix or mitigation. Please allow reasonable time for review before public disclosure.

## Security expectations

Authentication, Firestore rules, Storage rules, and guest-mode persistence are security-sensitive. Changes to these areas must include tests or explicit verification notes. Never commit `.env` files, Firebase Admin credentials, OAuth secrets, or exported user content.
