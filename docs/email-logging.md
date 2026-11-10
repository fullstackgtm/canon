# Logging email by BCC or forward

Each member gets a private address under **Settings → Email logging**. It looks
like `log+<token>@<your logging domain>`.

- **BCC it** when you email a customer. The email goes on the timeline of each
  person on it who is in Canon, and into the Conversations section of their
  company and of the deals they are on.
- **Forward it** an email you received. Canon logs the original: who sent it,
  when they sent it, and to whom. It reads the forward headers Gmail, Outlook
  and Apple Mail write, and messages forwarded as attachments.

It works from any mail client, needs no mailbox connection, and works on a
self-hosted install.

## What is kept

- The subject, the time it was sent, whether you sent it or received it, the
  people on it (From, To and Cc), and the Message-ID, In-Reply-To and
  References headers, so a reply joins its thread.
- The plain text above the quoted reply chain. When the chain can't be cut
  safely, the whole text is kept. HTML is never shown: an HTML-only email is
  turned into text. Text over 50,000 characters is cut, and the cut is marked.
- The names and sizes of attachments, not their content.

The same email is stored once per workspace: delivered twice, BCCed by you and
forwarded by a teammate, or already read from a linked Gmail inbox.

## Who sees it

The email is yours. Anyone who can see the person it was with sees that it
happened (who, when, the subject). Its text is shown to you and to roles that
can read your activity, the same rule as email read from a linked inbox. A
member who can't see the person can't open it.

## What it never does

- It never sends, schedules or enrolls anyone in anything.
- It creates no people or companies. Someone on the email who isn't in Canon
  is suggested to you, with their company, for you to add or dismiss.
- It doesn't log mail that wasn't sent from your own address. The From must be
  your sign-in email or a Gmail inbox you linked. Anything else is listed under
  "Not logged" in Settings and dropped.

Keep the address private. Canon checks that the From is yours, but it does not
check the sender's DKIM or DMARC result, so someone who learns your address can
send it mail that claims to be from you. If the address leaks, choose
**Generate a new address**. Mail to the old one is refused from then on.

## Set up email logging on a self-hosted install

Email logging is off until the backend has both of these environment variables:

| Name | Value |
|---|---|
| `EMAIL_LOG_DOMAIN` | The domain whose mail reaches Canon, such as `log.example.com`. Members' addresses are `log+<token>@` this domain. |
| `EMAIL_LOG_SECRET` | A long random string, such as the output of `openssl rand -hex 32`. Only the adapter that delivers mail to Canon knows it. |

With Docker Compose, add both to the `environment` of the `canoncrm` service,
for example in a `docker-compose.override.yml`, and run
`docker compose up -d`. The container passes them to its backend on start.
`npm run selfhost:doctor` shows whether email logging is on. Settings hides the
area while it is off.

Use a domain or subdomain that receives no other mail, because every message
sent to it goes to Canon. Point its MX records at the service that receives the
mail, then have that service POST each message to Canon. The endpoints are on
your HTTP actions URL. On the Docker install that is your `SITE_URL` followed by
`/convex-site`. On Convex Cloud it is the deployment's `.convex.site` URL.

| Endpoint | Body |
|---|---|
| `POST /email-log/raw?to=<envelope recipient>&from=<envelope sender>` | The raw RFC 822 message. |
| `POST /email-log/postmark` | Postmark's inbound webhook JSON. |

Every request carries the secret, as `Authorization: Bearer <EMAIL_LOG_SECRET>`
or as the password of HTTP basic auth. Canon answers with one of these codes:

| Code | Body `status` | Meaning |
|---|---|---|
| `200` | `logged`, `duplicate` or `skipped` | Stored, already stored, or nobody outside your team was on it. |
| `202` | `held` | Not logged, and listed under "Not logged" in the member's Settings. |
| `400` | `unreadable` | The body is not a message the endpoint reads. |
| `401` | `unauthorized` | The secret is wrong or missing. |
| `403` | `unknown_address` | No member has this address, or it was replaced. |
| `404` | `off` | Email logging is off on this backend. |
| `413` | `too_large` | The request is over 15 MB. |
| `429` | `rate_limited` | The address got more than 120 messages this hour. |

Pass the envelope recipient in `to`, because a BCC recipient appears in no
header. When you pass the envelope sender in `from`, it must also be the
member's own address, without any `+tag`.

### Deliver with a Cloudflare Email Worker

1. In Cloudflare, enable Email Routing for the logging domain.
2. Create a Worker with the code below, and give it two secrets:
   `CANON_URL` (your HTTP actions URL) and `EMAIL_LOG_SECRET`.
3. Add a catch-all routing rule that sends the domain's mail to the Worker.

```js
export default {
  async email(message, env) {
    const url = new URL(`${env.CANON_URL}/email-log/raw`);
    url.searchParams.set("to", message.to);
    url.searchParams.set("from", message.from);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.EMAIL_LOG_SECRET}`, "Content-Type": "message/rfc822" },
      body: message.raw,
    });
    if (!res.ok) message.setReject(`Canon answered ${res.status}`);
  },
};
```

A rejected message bounces to its sender, so a member learns when an address
was replaced.

### Deliver from any mail server

Save this script as `/usr/local/bin/canon-email-log` and make it executable.
It reads one message on standard input and takes the envelope recipient and
sender as its two arguments:

```sh
#!/bin/sh
# Usage: canon-email-log <envelope recipient> <envelope sender> < message
set -eu
CANON_URL="${CANON_URL:-https://crm.example.com/convex-site}"
HEADER_FILE="${CANON_EMAIL_LOG_HEADER:-/etc/canon/email-log.header}"
enc() { printf '%s' "$1" | sed 's/%/%25/g; s/+/%2B/g; s/&/%26/g; s/=/%3D/g; s/#/%23/g; s/ /%20/g'; }
exec curl --fail-with-body -sS -X POST \
  -H "@$HEADER_FILE" \
  -H "Content-Type: message/rfc822" \
  --data-binary @- \
  "$CANON_URL/email-log/raw?to=$(enc "$1")&from=$(enc "$2")"
```

The secret stays out of the command line. Put it in the header file, readable
only by the user that runs the script:

```sh
printf 'Authorization: Bearer %s\n' "$EMAIL_LOG_SECRET" > /etc/canon/email-log.header
chmod 600 /etc/canon/email-log.header
```

To check the setup, send a message you saved as a file. Use your own logging
address as the recipient and your sign-in email as the sender:

```sh
canon-email-log log+<token>@log.example.com you@example.com < message.eml
```

A logged message prints `{"status":"logged",...}`. With Postfix, a `pipe`
transport for the logging domain can call the script as
`argv=/usr/local/bin/canon-email-log ${recipient} ${sender}`.

### Deliver with Postmark

1. In your Postmark server, set up inbound domain forwarding for the logging
   domain, so mail to any address at it reaches Postmark.
2. Set the inbound webhook URL to
   `https://canon:<EMAIL_LOG_SECRET>@<your HTTP actions host and path>/email-log/postmark`.
   Postmark sends the credentials as HTTP basic auth.
3. Optionally, turn on the option to include the raw email content. Canon then
   reads the raw message, the same as the raw endpoint does.

Postmark stops retrying a message when Canon answers `403`. Postmark sends no
envelope sender, so with Postmark only the From is checked.
