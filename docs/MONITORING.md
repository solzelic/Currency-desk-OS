# Monitoring

Nothing here sends data until Sol turns it on. With `SENTRY_DSN` unset,
the server does not load Sentry, and `GET /api/health` answers exactly as
it does today.

## What Sol does

1. **Create a Sentry project.** The free plan is enough. Copy the DSN.
   Do not put it in git, in `render.yaml`, or in a chat.

2. **Put `SENTRY_DSN` in Render.** Open the CurrencyDesk web service,
   Environment, and add `SENTRY_DSN`. Save it. The next deploy starts
   sending server errors. Optional: `SENTRY_ENVIRONMENT=production`.
   The release on each event is `RENDER_GIT_COMMIT`, which Render already
   sets. Remove the variable to stop sending. No code change.

3. **Add a free uptime check.** In UptimeRobot or Better Stack, monitor
   `https://currencydesk.onrender.com/api/health` every 5 minutes. Alert
   by email to the address Sol actually reads. Use that path, not
   `/api/health/deep`. The deep check is for a person. The short one is
   what Render already uses, and it fails when the database cannot answer.

## What gets sent

Server errors: a 5xx response, or a crash the process did not catch.
Each event is tagged with the environment and, when Render has it, the
git SHA.

## What is never sent

Request bodies, customer names, identity numbers, amounts, cookies, and
authorization headers are stripped before anything is handed to Sentry.
The deep health body is `ok`, `service`, `migrations`, `version`, and
`commit`. No connection string and no DSN.

`GET /api/health/deep` checks that the database answers one read, and
reports how many checksummed migrations are applied. On a database that
has never run them the count is null, not zero. The check is rate-limited.
