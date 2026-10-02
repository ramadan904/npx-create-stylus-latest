# Releasing to npm

Publishing is automated: pushing a version tag runs `.github/workflows/publish.yml`, which tests the package, smoke-tests
the packed tarball for every template, and publishes it to npm with a provenance statement.

## One-time setup

1. Create an **automation** access token on npmjs.com (Access Tokens, Granular or Automation) that can publish
   `create-stylus-latest`.
2. Add it to this repository as the secret `NPM_TOKEN` (Settings, Secrets and variables, Actions).

## Cut a release

```bash
npm version patch            # or minor / major: bumps package.json and creates the v* tag
git push --follow-tags
```

The workflow refuses to publish if the tag and `package.json` disagree, and npm refuses to publish a version that already
exists, so a release cannot silently overwrite an earlier one.

## Rehearse without releasing

Actions, **Publish to npm**, Run workflow, leave "Dry run" ticked. It packs the tarball, runs the smoke test and does
`npm publish --dry-run`, using no token.

Locally, `npm run smoke:pack` runs the same smoke test: it packs the tarball, runs it with `npx` in an empty directory
and scaffolds every template, so a file missing from the package fails here and not on a stranger's machine.

## After the first publish

Anyone can now run `npx create-stylus-latest my-app` (or `npm create stylus-latest my-app`). The version printed by
`create-stylus-latest --version` is the one in `package.json`.
