# ADR-0006: Use nginx basic auth at the gateway and an optional X-API-Key at the API

- Status: Accepted
- Date: 2026-10-02

## Context

The Pi is a home server with ports 80 and 443 open to the internet. It serves
three things: the dashboard, the API and Grafana. It has one owner and a small
number of users.

- One authentication layer must protect all three, with no user database and
  no session store.
- `POST /api/chat` can spend money at a cloud provider. A person who can see the
  dashboard must not always get the chat.
- Some clients call the API without the gateway: the laptop dev stack publishes
  the API on `127.0.0.1:8000`, and other containers share the Docker network.

During integration, a test in Chromium showed a problem. One `401` response from
the API made Chromium delete the cached basic-auth credentials. The browser then
asked for the site password again.

## Decision

- The gateway uses HTTP basic auth on all HTTPS paths. The exceptions are
  `/api/health` (for uptime checks) and the ACME challenge path on port 80
  ([`picloud.conf.template`](../../deploy/nginx/templates/picloud.conf.template)).
- `create-htpasswd.sh` hashes passwords with SHA-512 crypt, and refuses
  passwords shorter than 12 characters. It does not use bcrypt. Basic auth has
  no session, so nginx checks the hash on each request. With bcrypt (cost 12),
  each check took about 0.45 s of the 0.5 CPU limit of the gateway, and one
  Grafana page loads about 130 files.
- The API has an optional second secret, `PICLOUD_API_KEY`. When you set it,
  `POST /api/chat` requires the same value in the `X-API-Key` header
  ([`chat.py`](../../api/src/picloud_api/routes/chat.py)).
- The API compares the key in constant time. A bad or absent key gets `403`,
  not `401`, because the gateway owns `401`.
- The API key does not use the `Authorization` header, because basic auth uses
  it.
- Grafana gives anonymous users the Viewer role behind the gateway. The gateway
  removes the basic-auth header before it sends a request to Grafana. To edit
  dashboards, log in with the Grafana admin account.

## Consequences

- The setup needs one command per user, and no database.
- The browser handles the login, so the dashboard has no login page.
- The site password and the chat key are separate. You can share the dashboard
  and keep the chat private.
- Basic auth has no second factor, no lockout and no logout. fail2ban does not
  watch the gateway log. A strong password is the main control.
- SHA-512 crypt is faster to guess than bcrypt, if a person gets the
  `htpasswd` file. The length rule (12 characters) decreases this risk.
- The browser keeps the API key in `localStorage`. Any script on the page can
  read it. The Content-Security-Policy allows scripts from the same origin only.
