import hashlib
import hmac
import os
import secrets
import time
from email.utils import formataddr

import requests

from email_templates import vex_otp_email

OTP_TTL_SECONDS = int(os.getenv("OTP_TTL_SECONDS", "600"))
OTP_RESEND_COOLDOWN_SECONDS = int(os.getenv("OTP_RESEND_COOLDOWN_SECONDS", "60"))
OTP_MAX_ATTEMPTS = int(os.getenv("OTP_MAX_ATTEMPTS", "5"))


def normalize_email(email: str) -> str:
    return str(email or "").strip().lower()


def email_key(email: str) -> str:
    return hashlib.sha256(normalize_email(email).encode("utf-8")).hexdigest()


def generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def otp_digest(email: str, code: str) -> str:
    secret = os.getenv("OTP_SECRET") or os.getenv("API_SECRET_KEY")
    if not secret or secret == "vex-super-secret-jwt-key-change-in-prod":
        raise RuntimeError("OTP_SECRET must be configured before sending verification codes")
    return hmac.new(secret.encode("utf-8"), f"{email_key(email)}:{code}".encode("utf-8"), hashlib.sha256).hexdigest()


def now_seconds() -> int:
    return int(time.time())


def build_otp_record(email: str, code: str) -> dict:
    now = now_seconds()
    return {
        "email_hash": email_key(email),
        "code_hash": otp_digest(email, code),
        "created_at": now,
        "expires_at": now + OTP_TTL_SECONDS,
        "resend_after": now + OTP_RESEND_COOLDOWN_SECONDS,
        "attempts": 0,
        "max_attempts": OTP_MAX_ATTEMPTS,
    }


def verify_digest(email: str, code: str, record: dict) -> bool:
    expected = record.get("code_hash", "")
    return bool(expected) and hmac.compare_digest(expected, otp_digest(email, code))


def send_resend_otp(email: str, code: str) -> str:
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("RESEND_API_KEY is not configured")
    sender = os.getenv("RESEND_FROM", "Vex <onboarding@resend.dev>").strip()
    html, text = vex_otp_email(email, code, max(1, OTP_TTL_SECONDS // 60))
    response = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "from": sender,
            "to": [email],
            "subject": "Your Vex verification code",
            "html": html,
            "text": text,
        },
        timeout=15,
    )
    if response.status_code >= 400:
        try:
            detail = response.json().get("message") or response.text
        except Exception:
            detail = response.text
        raise RuntimeError(f"Resend rejected the email: {detail[:300]}")
    return str(response.json().get("id", ""))
