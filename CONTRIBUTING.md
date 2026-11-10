# Contribute to CanonCRM

## Before your first pull request

Sign the contributor license agreement in [CLA.md](CLA.md). You keep the
copyright in what you write. The agreement licenses it to Full Stack GTM LLC,
which also ships this code in the hosted CanonCRM service and in modules that
are not open source. [CLA.md](CLA.md) starts with a short summary of what
signing does and does not do.

To sign, add a file named `contributors/<your GitHub login in lower case>.md`
to your first pull request, with this content:

```text
I agree to the Canon Contributor License Agreement in CLA.md, version 1.

Name: Your full name
GitHub: your-github-login
Date: 2026-11-09
```

Use the date you sign. If your employer owns the code you write, get its
written permission first and add an `Employer:` line that names it.

The `cla` check on your pull request fails until the file is there and its
`GitHub:` line matches the account that opened the pull request. You sign once.
Later pull requests pass because the file is already in the repository. The
check reads only that file. It does not run the code in your pull request.

## Develop

Use Node.js 22.6 or newer. Install dependencies with `npm ci`.
Run `npm run typecheck` and `npm run build` before opening a pull request.
Use synthetic data and reserved example domains in tests. Never commit credentials
or customer information.

Keep changes focused. Describe the behavior you changed and how you verified it
in the pull request. Report security issues privately to the maintainers rather
than including credentials or exploit details in a public issue.

## License

The `engine/` and `modules/kernel/` directories use Apache-2.0. Everything
else uses AGPL-3.0-only. Contributions follow the license of the files they change, and the
contributor license agreement also licenses them to Full Stack GTM LLC.
