"""
cf_error_pages.py
-----------------
Serves branded HTML error/status pages for Cloudflare Zero Trust
device-binding events.  Only mounted when CF_ZERO_TRUST_ENABLED=true.

Pages:
  GET /cf-blocked  — device fingerprint mismatch (access denied)
  GET /cf-verify   — fingerprint not yet submitted (loading / in-progress)
  GET /cf-unbound  — device successfully unlinked
"""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

# ---------------------------------------------------------------------------
# Shared CSS / design tokens
# ---------------------------------------------------------------------------

_CSS = """
  :root {
    --bg:        #0d0f14;
    --card:      #151820;
    --border:    #252a35;
    --accent:    #6c63ff;
    --accent2:   #ff6584;
    --success:   #43e97b;
    --warn:      #f7b731;
    --text:      #e8eaf0;
    --subtext:   #7a8099;
    --radius:    14px;
    --shadow:    0 8px 40px rgba(0,0,0,.55);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    overflow: hidden;
  }

  /* Animated grid background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(108,99,255,.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(108,99,255,.04) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
  }

  .card {
    position: relative;
    z-index: 1;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 48px 40px;
    max-width: 480px;
    width: 100%;
    text-align: center;
    animation: pop .35s cubic-bezier(.22,1,.36,1);
  }

  @keyframes pop {
    from { opacity: 0; transform: translateY(18px) scale(.97); }
    to   { opacity: 1; transform: none; }
  }

  .icon {
    font-size: 52px;
    line-height: 1;
    margin-bottom: 20px;
    display: block;
    filter: drop-shadow(0 0 20px currentColor);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    padding: 4px 12px;
    border-radius: 99px;
    margin-bottom: 18px;
  }

  .badge.error   { background: rgba(255,101,132,.12); color: var(--accent2); border: 1px solid rgba(255,101,132,.25); }
  .badge.info    { background: rgba(108,99,255,.12);  color: var(--accent);  border: 1px solid rgba(108,99,255,.25); }
  .badge.success { background: rgba(67,233,123,.12);  color: var(--success); border: 1px solid rgba(67,233,123,.25); }

  h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -.01em;
    margin-bottom: 10px;
    color: var(--text);
  }

  p {
    font-size: 14px;
    color: var(--subtext);
    line-height: 1.65;
    margin-bottom: 28px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 11px 24px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    border: none;
    transition: opacity .18s, transform .18s;
  }
  .btn:hover { opacity: .85; transform: translateY(-1px); }
  .btn:active { transform: none; }

  .btn-primary { background: var(--accent); color: #fff; }
  .btn-danger  { background: var(--accent2); color: #fff; }
  .btn-ghost   {
    background: transparent;
    color: var(--subtext);
    border: 1px solid var(--border);
  }

  .divider {
    height: 1px;
    background: var(--border);
    margin: 24px 0;
  }

  .meta {
    font-size: 11px;
    color: var(--subtext);
    opacity: .6;
  }

  /* Spinner for verifying page */
  .spinner {
    width: 48px;
    height: 48px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 0 auto 20px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
"""

_BASE_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} — Pixmap</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>{css}</style>
</head>
<body>
  <div class="card">
    {body}
    <div class="divider"></div>
    <p class="meta">dev.pixmap.fun &nbsp;·&nbsp; Cloudflare Zero Trust</p>
  </div>
</body>
</html>"""


def _page(title: str, body: str) -> HTMLResponse:
    html = _BASE_HTML.format(title=title, css=_CSS, body=body)
    return HTMLResponse(content=html)


# ---------------------------------------------------------------------------
# /cf-blocked  — device mismatch (access denied)
# ---------------------------------------------------------------------------

@router.get("/cf-blocked", include_in_schema=False)
async def cf_blocked_page():
    """Shown when a CF email is already bound to a different device fingerprint."""
    body = """\
<span class="icon" style="color:#ff6584">🔒</span>
<div class="badge error">&#x2715; Access Denied</div>
<h1>Device Not Recognised</h1>
<p>
  Your Cloudflare Access account is already linked to a different
  device. Only the original device can access Pixmap with this identity.
</p>
<a href="/" class="btn btn-ghost">← Back to Pixmap</a>
"""
    return _page("Access Denied", body)


# ---------------------------------------------------------------------------
# /cf-verify  — fingerprint pending (user should wait / retry)
# ---------------------------------------------------------------------------

@router.get("/cf-verify", include_in_schema=False)
async def cf_verify_page():
    """Shown while device verification is in progress."""
    body = """\
<div class="spinner"></div>
<div class="badge info">Verifying</div>
<h1>Verifying Your Device</h1>
<p>
  We're confirming your device identity through Cloudflare Zero Trust.
  This should only take a moment.
</p>
<p>
  If this page doesn't go away automatically, try refreshing.
</p>
<a href="/" class="btn btn-primary" id="retry-btn">Retry</a>
<script>
  // Auto-redirect to home after a short delay; the frontend will
  // re-attempt /auth/cf/bind on load.
  setTimeout(function() {
    window.location.href = '/';
  }, 3000);
</script>
"""
    return _page("Verifying Device", body)


# ---------------------------------------------------------------------------
# /cf-unbound  — device successfully unlinked
# ---------------------------------------------------------------------------

@router.get("/cf-unbound", include_in_schema=False)
async def cf_unbound_page():
    """Shown after a user successfully disconnects their device."""
    body = """\
<span class="icon" style="color:#43e97b">✓</span>
<div class="badge success">Device Unlinked</div>
<h1>Device Disconnected</h1>
<p>
  Your device has been unlinked from your Cloudflare Access account.
  The next time you sign in, your new device will be registered
  automatically.
</p>
<a href="/" class="btn btn-primary">← Back to Pixmap</a>
"""
    return _page("Device Disconnected", body)


# ---------------------------------------------------------------------------
# /cf-error  — generic / unexpected error
# ---------------------------------------------------------------------------

@router.get("/cf-error", include_in_schema=False)
async def cf_error_page():
    """Generic fallback error page for unexpected CF Zero Trust failures."""
    body = """\
<span class="icon" style="color:#f7b731">⚠</span>
<div class="badge error">Error</div>
<h1>Something Went Wrong</h1>
<p>
  An unexpected error occurred during device verification.
  Please try again — if the problem persists, contact an administrator.
</p>
<a href="/" class="btn btn-ghost" style="margin-right:8px">← Home</a>
<a href="/auth/discord" class="btn btn-primary">Try Again</a>
"""
    return _page("Verification Error", body)
