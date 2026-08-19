from html import escape


def vex_otp_email(recipient_email: str, code: str, expires_minutes: int = 10) -> tuple[str, str]:
    """Return the branded HTML and plain-text Vex verification email."""
    safe_email = escape(recipient_email)
    safe_code = escape(code)
    html = f"""<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\">
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
    <title>Your Vex verification code</title>
  </head>
  <body style=\"margin:0;background:#f6f1e9;color:#252426;font-family:Arial,Helvetica,sans-serif;\">
    <div style=\"padding:42px 16px;\">
      <div style=\"max-width:560px;margin:0 auto;background:#fffdf8;border:1px solid #ded8cf;border-radius:24px;overflow:hidden;box-shadow:0 16px 40px rgba(37,36,38,.08);\">
        <div style=\"padding:26px 30px;border-bottom:1px solid #ece6dc;background:#252426;color:#f7f4ec;\">
          <div style=\"display:flex;align-items:center;gap:12px;font-size:22px;font-weight:800;letter-spacing:-.04em;\">
            <span style=\"display:inline-grid;place-items:center;width:38px;height:38px;border-radius:12px;background:#f7f4ec;color:#252426;font-size:14px;transform:rotate(-7deg);box-shadow:4px 4px 0 #f26b4f;\">vx</span>
            <span>Vex</span>
          </div>
        </div>
        <div style=\"padding:34px 30px 30px;\">
          <p style=\"margin:0 0 10px;color:#ef6c4f;font:700 11px/1.4 monospace;letter-spacing:.14em;text-transform:uppercase;\">VEX / CONFIRMATION</p>
          <h1 style=\"margin:0 0 14px;font-size:32px;line-height:1.08;letter-spacing:-.045em;\">Make room for good thoughts.</h1>
          <p style=\"margin:0;color:#6d675f;font-size:15px;line-height:1.65;\">Use the code below to verify <strong style=\"color:#252426;\">{safe_email}</strong> and continue into your synced Vex space.</p>
          <div style=\"margin:28px 0;padding:24px 18px;text-align:center;border:1px dashed #b9b0a4;border-radius:16px;background:#fff9e8;\">
            <div style=\"color:#8b8277;font:10px/1.3 monospace;letter-spacing:.16em;text-transform:uppercase;\">one-time code</div>
            <div style=\"margin-top:8px;color:#252426;font:800 40px/1.1 monospace;letter-spacing:.22em;\">{safe_code}</div>
            <div style=\"margin-top:10px;color:#8b8277;font-size:12px;\">Expires in {expires_minutes} minutes</div>
          </div>
          <p style=\"margin:0;color:#6d675f;font-size:13px;line-height:1.6;\">If you did not request this code, you can safely ignore this email. Never share the code with anyone.</p>
        </div>
        <div style=\"padding:18px 30px;border-top:1px solid #ece6dc;color:#8b8277;font-size:11px;line-height:1.5;\">
          Vex by <a href=\"https://github.com/itsjustayush\" style=\"color:#252426;\">Ayush Bhattacharya</a> · <a href=\"https://github.com/itsjustayush/Vex2.0\" style=\"color:#252426;\">view the project</a>
        </div>
      </div>
    </div>
  </body>
</html>"""
    text = (
        f"Vex verification code\n\n"
        f"Use {code} to verify {recipient_email} and continue into your synced Vex space.\n\n"
        f"This code expires in {expires_minutes} minutes. If you did not request it, ignore this email. Never share the code.\n\n"
        f"Vex by Ayush Bhattacharya — https://github.com/itsjustayush/Vex2.0\n"
    )
    return html, text
