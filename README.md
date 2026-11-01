<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/aricxpoint-labs-logo-white.png">
    <img alt="aricxpoint labs" src=".github/aricxpoint-labs-logo-black.png" width="320">
  </picture>
</p>

# paylab-payment-svc

Part of **PayLab** (aricxpoint DevOps class: "Payment Web App Deployment").

Owns the `payments` table: one person paying another. Internal only (reached through the gateway's `/api/payments*`).

`POST /payments` with `{"fromWalletId":1,"toHandle":"bola","amountKobo":150000,"reference":"ref-1","note":"Lunch"}`
(`toWalletId` works instead of `toHandle`):

1. looks up the payer and resolves the payee's handle via wallet-svc (404 if either is unknown, 400 if it's the same wallet),
2. inserts the payment as `pending`. Idempotent: the same `reference` returns the existing payment, never a second charge,
3. calls wallet-svc `POST /transfers`, which debits the payer and credits the payee in one DB transaction,
4. marks it `success` (HTTP 201) or `failed` (HTTP **402** with `reason`, e.g. `insufficient funds`),
5. fire-and-forget `POST /notify` to notify-svc with both parties (a notify failure never fails the payment).

If wallet-svc can't be reached, the payment stays `pending` (HTTP 502). Retrying with the **same reference** finishes it safely,
because `/transfers` is idempotent too.

Also:
- `GET /payments?walletId=1`: payments where wallet 1 paid or was paid, newest first, with `payer_handle`, `payee_handle` and `direction` (`sent`/`received`).
- `GET /payments` (latest 50), `GET /payments/:id`, `GET /health`.

Table (created on startup):

```
payments (id, reference UNIQUE, payer_wallet_id, payee_wallet_id, amount_kobo, note,
          status pending|success|failed, reason, created_at)
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `PORT` | `8081` | |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | `localhost` / `5432` / `paylab` / `paylab` | |
| `DB_PASSWORD` | `paylab` | On AWS ECS injects it from SSM Parameter Store `/paylab/db/password` (SecureString). |
| `DB_SSL` | unset | Set `true` on AWS (RDS requires TLS). |
| `WALLET_URL` | `http://wallet-svc:8082` | On AWS the task definition sets `http://wallet-svc.paylab.internal:8082` (ECS Service Discovery / Cloud Map). |
| `NOTIFY_URL` | `http://notify-svc:8083` | On AWS: `http://notify-svc.paylab.internal:8083`. |

## Run it alone with Docker

payment-svc needs Postgres and calls wallet-svc and notify-svc, so run those too
(build them from their own repos first). Container names = the hostnames in the default URLs.

```bash
docker network create paylab
docker run -d --name pg --network paylab \
  -e POSTGRES_DB=paylab -e POSTGRES_USER=paylab -e POSTGRES_PASSWORD=paylab-local-pass \
  -p 5432:5432 postgres:16-alpine

docker run -d --name wallet-svc --network paylab -p 8082:8082 -e DB_HOST=pg -e DB_PASSWORD=paylab-local-pass paylab/wallet-svc
docker run -d --name notify-svc --network paylab paylab/notify-svc

docker build -t paylab/payment-svc .
docker run --rm --name payment-svc --network paylab -p 8081:8081 \
  -e DB_HOST=pg -e DB_PASSWORD=paylab-local-pass paylab/payment-svc

# in another terminal: two wallets, then a payment
curl -s -X POST localhost:8082/wallets -H 'Content-Type: application/json' -d '{"owner":"Ada","handle":"ada"}'
curl -s -X POST localhost:8082/wallets -H 'Content-Type: application/json' -d '{"owner":"Bola","handle":"bola"}'
curl -s -X POST localhost:8081/payments -H 'Content-Type: application/json' \
  -d '{"fromWalletId":1,"toHandle":"bola","amountKobo":150000,"reference":"ref-1","note":"Lunch"}'
curl -s 'localhost:8081/payments?walletId=2'
docker logs notify-svc     # "sent" + "received" receipts
```

Clean up: `docker rm -f pg wallet-svc notify-svc && docker network rm paylab`

## Deployment (AWS)

This repo is deployed by its own **CodePipeline** `paylab-payment-svc-pipeline` on every push to `main`:

```
git push (main) -> CodePipeline Source -> CodeBuild (buildspec.yml) -> ECR paylab/payment-svc:<commit> -> ECS service "payment-svc" in cluster "paylab"
```

| File | Purpose |
|---|---|
| `buildspec.yml` | CodeBuild steps: log in to ECR, build, push `:<short-commit>` and `:latest`, write `imagedefinitions.json`. |
| `taskdef.json` | ECS task definition template (with `<ACCOUNT_ID>`-style placeholders). Registered by `paylab-infra/terraform` (`ecs.tf`); the pipeline then registers a new revision on every deploy. |

The container name in `taskdef.json` and in `imagedefinitions.json` is `payment-svc`. They **must match**, or the deploy stage fails.

The shared AWS setup (network, database, cluster, load balancer, pipelines) lives in the **paylab-infra** repo.
