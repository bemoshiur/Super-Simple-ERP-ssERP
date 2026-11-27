# Install with Docker

> **Status:** the Dockerfile and `docker-compose.yml` were written against the standalone Next.js build, which was
> built and started locally, but **`docker build` itself has not been run by the maintainers yet** (v0.1.0). Please
> report any problem in an issue.

## With an external database (Neon or any PostgreSQL)

```bash
git clone https://github.com/bemoshiur/Super-Simple-ERP-ssERP.git
cd Super-Simple-ERP-ssERP
cp .env.example .env
# edit .env: DATABASE_URL, AUTH_SECRET (openssl rand -base64 48) and INSTALL_TOKEN (openssl rand -hex 16)
docker compose up -d --build
```

Open <http://localhost:3000/install>, enter the install token and finish the wizard. The container runs in production
mode, so the token is mandatory for the web installer.

## With the bundled PostgreSQL

The compose file has an optional `postgres` profile (`postgres:16-alpine`, data in the `sserp-pgdata` volume). In
`.env` set:

```
POSTGRES_PASSWORD=choose-a-password
DATABASE_URL=postgresql://sserp:choose-a-password@postgres:5432/sserp
DB_DRIVER=pg
```

and start with:

```bash
docker compose --profile postgres up -d --build
```

The database port is not published. To reach it from the host (for `npm run admin:reset` or backups), add this under
the `postgres` service in `docker-compose.yml`:

```yaml
    ports: ['127.0.0.1:5432:5432']
```

You are responsible for backing up that volume (see [Upgrading and Backups](Upgrading-and-Backups)).

## What the image contains

- A multi-stage build on `node:22-alpine`. The app stage uses Next.js **standalone** output, which only the
  Dockerfile enables (`SSERP_STANDALONE=1`), so a normal `npm run build && npm start` is unaffected.
- It runs as a non-root user (`nextjs`, uid 1001) on port 3000.
- A health check calls `/api/health` every 30 seconds. That endpoint never touches the database.
- A separate `migrate` stage (dependencies and source, no Next.js build) runs `scripts/migrate.ts` for upgrades.

## Health checks

| URL | Checks | Use for |
| --- | --- | --- |
| `/api/health` | The app answers | Docker and uptime probes |
| `/api/health?db=1` | Also the database (cached 5 s) and pending migrations | Occasional diagnostics |

`/api/health?db=1` replies `{"status":"ok","db":"up","migrations":"ok"}` (or `"pending"`), or HTTP 503 with
`"db":"down"`. It connects to the database, so it can wake a suspended Neon database.

## Upgrading

Back up first, then:

```bash
git pull
docker compose --profile migrate run --rm --build migrate      # add --profile postgres with the bundled Postgres
docker compose up -d --build
```

Apply the migrations before starting the new app version. Details: [Upgrading and Backups](Upgrading-and-Backups).

## Reset the admin password

The image does not contain the script tooling. From a clone of the repository, with `DATABASE_URL` pointing at the
same database (your Neon string, or `postgresql://sserp:YOUR_PASSWORD@127.0.0.1:5432/sserp` after publishing the
port), run `npm run admin:reset -- --email you@example.com`. It needs the app's `AUTH_SECRET` in the environment to
clear the per-email lockout.

## Behind a reverse proxy

Terminate HTTPS in the proxy. Set `TRUSTED_PROXY=true` only when the proxy overwrites `X-Forwarded-For` /
`X-Real-IP` and the container is not reachable directly.

`HSTS=1` and `CSP_ENFORCE=1` are read when Next.js **builds** the app. Compose's `env_file` only reaches the running
container, and the Dockerfile does not pass these variables to its build stage, so setting them in `.env` has no
effect. To use them, add `ENV HSTS=1` and/or `ENV CSP_ENFORCE=1` to the `build` stage of your copy of the Dockerfile.
See [Security Model](Security-Model).

Last verified against v0.1.0 (files reviewed; `docker build` not yet run).
