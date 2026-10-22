# ADR-0006: Use nginx basic auth at the gateway and an optional X-API-Key at the API

- Status: Accepted
- Date: 2026-10-02

## Context

The Pi has 80 and 443 open to the internet and serves the dashboard, the API,
and Grafana to me and a few other people. I wanted one auth layer over all
three, with no user database or session store. `POST /api/chat` can spend money
at a cloud provider, so being able to see the dashboard shouldn't always mean
being able to chat. Some clients also reach the API without going through the
gateway: the dev stack publishes it on `127.0.0.1:8000`, and other containers
share the Docker network. During integration, Chromium showed that a single
`401` from the API made it throw away the saved basic-auth login and ask for
the site password again.

## Decision

nginx puts HTTP basic auth on every HTTPS path except `/api/health` (for uptime
checks) and the ACME challenge on port 80
([`picloud.conf.template`](../../deploy/nginx/templates/picloud.conf.template)).
`create-htpasswd.sh` hashes with SHA-512 crypt and refuses passwords under 12
characters. Not bcrypt: nginx checks the hash on every request, bcrypt cost 12
took about 0.45 s of the gateway's 0.5 CPU, and a Grafana page loads about 130
files.

The API takes an optional second secret, `PICLOUD_API_KEY`. When it's set,
`POST /api/chat` needs it in `X-API-Key`, compared in constant time
([`chat.py`](../../api/src/picloud_api/routes/chat.py)). A missing or wrong key
gets `403`, because `401` belongs to the gateway, and `Authorization` is
already taken by basic auth. Grafana gives anonymous users the Viewer role, and
the gateway strips the basic-auth header before proxying to it. Editing
dashboards needs the Grafana admin login.

## Consequences

- Adding a user is one command. No database, and no login page to build.
- The site password and the chat key are separate, so I can share the
  dashboard and keep the chat to myself.
- Basic auth has no second factor, no lockout, and no logout, and fail2ban
  doesn't watch the gateway log. A strong password is doing most of the work.
- If someone gets the `htpasswd` file, SHA-512 crypt is faster to crack than
  bcrypt. The 12-character minimum is the mitigation.
- The browser keeps the API key in `localStorage`, where any script on the page
  can read it. The CSP only allows same-origin scripts.
