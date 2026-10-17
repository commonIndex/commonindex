"""Sending email: sign-in codes and invitations.

Any SMTP service works (Gmail, Amazon SES, SendGrid, Postmark, Resend, a
company relay), through the standard library, so there is no SDK to pick and
no dependency to vet:

    COMMONINDEX_SMTP_HOST       smtp.example.com
    COMMONINDEX_SMTP_PORT       587 (STARTTLS), or 465 (TLS from the start)
    COMMONINDEX_SMTP_USER       ...
    COMMONINDEX_SMTP_PASSWORD   ...
    COMMONINDEX_MAIL_FROM       "Example Co <no-reply@example.com>"

Without a host, nothing is sent. For a developer's own machine,
COMMONINDEX_MAIL_LOG=1 writes each message to the gateway's log instead — a
setting for development only: whoever reads the log can sign in as anyone.
"""

from __future__ import annotations

import asyncio
import logging
import os
import smtplib
import ssl
from email.message import EmailMessage

log = logging.getLogger("commonindex.mail")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def configured() -> bool:
    """Whether a message can reach someone: SMTP, or the development log."""
    return bool(_env("COMMONINDEX_SMTP_HOST")) or _env("COMMONINDEX_MAIL_LOG") == "1"


def _send(to: str, subject: str, text: str) -> None:
    host = _env("COMMONINDEX_SMTP_HOST")
    if not host:
        log.warning("mail to %s (not sent — COMMONINDEX_MAIL_LOG is on)\nSubject: %s\n\n%s", to, subject, text)
        return
    message = EmailMessage()
    message["From"] = _env("COMMONINDEX_MAIL_FROM") or f"no-reply@{host}"
    message["To"] = to
    message["Subject"] = subject
    message.set_content(text)
    port = int(_env("COMMONINDEX_SMTP_PORT", "587"))
    user, password = _env("COMMONINDEX_SMTP_USER"), os.environ.get("COMMONINDEX_SMTP_PASSWORD", "")
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=20) as smtp:
            if user:
                smtp.login(user, password)
            smtp.send_message(message)
        return
    with smtplib.SMTP(host, port, timeout=20) as smtp:
        smtp.starttls(context=context)
        if user:
            smtp.login(user, password)
        smtp.send_message(message)


async def send(to: str, subject: str, text: str) -> bool:
    """Send one plain-text message. False, logged, when it could not go."""
    if not configured():
        return False
    try:
        await asyncio.to_thread(_send, to, subject, text)
    except (OSError, smtplib.SMTPException) as e:
        log.error("could not send mail to %s: %s", to, e)
        return False
    return True
