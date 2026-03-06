# Cloud Deployment (Azure-first)

## Target shape
- `web`: Next.js UI + API routes
- `worker`: BullMQ processor (`npm run worker`)
- `powershell-service`: Exchange PowerShell bridge
- Managed `PostgreSQL`, managed `Redis`, Blob storage, Key Vault

## Prerequisites
- Set `DATABASE_URL` to PostgreSQL
- Set `REDIS_URL` to managed Redis
- Set `PS_SERVICE_URL` to your deployed PowerShell service URL
- Set Graph, Cloudflare, Smartlead, Instantly, and `ENCRYPTION_KEY`

## Service commands
- Web: `npm run start`
- Worker: `npm run worker`
- PowerShell service: `node server.js` (inside `powershell-service`)

## Database migrations
- Run once per environment:

```bash
npm run prisma:migrate:deploy
```

## Local cloud-like smoke test
Use docker compose from repo root:

```bash
docker compose -f docker-compose.cloud.yml up --build
```

## Current known production gap
- CSV files are still persisted using local filesystem paths (`csvUrl` with local path). Move this to Blob/Object storage before high-scale rollout.
- PowerShell async job state is currently in-memory maps in `powershell-service/server.js`. Move this to Redis/DB if you want multi-instance horizontal scaling for that service.
