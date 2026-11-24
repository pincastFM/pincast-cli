# Releasing @pincast/cli

A tag `v<version>` on main publishes the package to npm through `.github/workflows/publish.yml`, with provenance. npm trusts that workflow by its file name, so no npm token is stored anywhere.

The first version is the exception. npm can only trust a workflow for a package that already exists, so 0.1.0 is published by hand.

The package depends on one exact version of `@pincast/api`. That version goes to npm first, every time. The Publish workflow stops if it isn't there.

## Every release

1. If `@pincast/api` has a new version, move the pin in `package.json` to it. Until that version is on npm, `npm run link-api` puts your local checkout of `pincast-api` in `node_modules`, after checking it holds the pinned version.

2. If the starter app moved, copy it in from one commit of the example app, then run the tests:

   ```sh
   node scripts/sync-template.js <path to pincast-kit-example> <commit>
   npm test
   ```

3. Write the changelog entry. The script reads the commit subjects since the last tag, and any move of the `@pincast/api` pin, then suggests the version by the rule in the README (Versions).

   ```sh
   npm run changelog                       # prints the entry and the version
   npm run changelog -- --write            # adds it to CHANGELOG.md and sets package.json's version
   npm run changelog -- --write --version 0.3.0   # the same, with a version you choose
   ```

   It reads subjects like `feat: ...` as Added, `fix: ...` as Fixed, and `feat!: ...` as Breaking, and leaves out docs, tests, CI and chores. A moved pin counts as at least a patch. When `@pincast/api`'s own change was bigger, pass that version with `--version`. Edit the entry so each line says what changed for someone running the command.

4. Commit, push main, and wait for CI to pass.

5. Tag that commit and push the tag.

   ```sh
   git tag -a v0.2.0 -m v0.2.0
   git push origin v0.2.0
   ```

   The Publish workflow checks that the tag names package.json's version, that the changelog has an entry for it, and that the pinned `@pincast/api` is on npm. It runs the tests, then publishes. When the version is on npm already, it says so, skips the publish, and passes.

6. `create-pincast` depends on one exact version of this package. To give `npm create pincast` the new version, move its pin and release it the same way, from its own repo.

## The first publish, by hand

The owner of the npm account `pincast` publishes 0.1.0, and approves it with the account's security key. Before you start:

- `@pincast/api` 0.1.0 is on npm.
- `pincastFM/pincast-cli` is public, and its main holds the commit to release.
- Your terminal has Node 22.14.0 or later and npm 11.15.0 or later. npm 11.15.0 is the first with `npm trust`, which the next section uses.

Run these in order. Each npm step that needs the account prints a link. Open it, sign in as `pincast`, and approve with the security key.

```sh
npm view @pincast/api@0.1.0 version --registry https://registry.npmjs.org      # 0.1.0
git clone https://github.com/pincastFM/pincast-cli.git
cd pincast-cli
node --version                     # v22.14.0 or later
npm --version                      # 11.15.0 or later
npm install --no-package-lock --registry https://registry.npmjs.org
npm test
npm pack                           # writes pincast-cli-0.1.0.tgz and prints its shasum
npm login --auth-type=web --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org      # pincast
npm publish pincast-cli-0.1.0.tgz --access public --registry https://registry.npmjs.org
npm view @pincast/cli@0.1.0 version dist.shasum --registry https://registry.npmjs.org
npm logout --registry https://registry.npmjs.org
```

The shasum from `npm view` matches the one `npm pack` printed. npm can take a few minutes to list a new package, so run `npm view` again if it finds nothing.

Then tag 0.1.0 and push the tag:

```sh
git tag -a v0.1.0 -m v0.1.0
git push origin v0.1.0
```

The Publish workflow runs the checks, finds 0.1.0 on npm, prints that there's nothing to publish, and passes. That's the expected result.

## Trusted publishing, set up on the day of the next release

A new trusted publisher expires if it hasn't published within 2 days. So set it up on the day you tag the next version.

On npmjs.com, signed in as `pincast`, open the package `@pincast/cli`, then Settings, then Trusted publishing, and choose GitHub Actions. Enter these, save, and approve with the security key:

| Field | Value |
|:-|:-|
| Organization or user | `pincastFM` |
| Repository | `pincast-cli` |
| Workflow filename | `publish.yml` |
| Environment name | leave it empty |

The same from a terminal, signed in as above:

```sh
npm trust github @pincast/cli --repo pincastFM/pincast-cli --file publish.yml --allow-publish
npm trust list @pincast/cli
```

Within the 2 days, tag the next version (Every release, step 5). The workflow publishes it with provenance. To see the provenance record:

```sh
npm view @pincast/cli@0.2.0 dist.attestations --registry https://registry.npmjs.org
```

If the 2 days pass first, remove the trusted publisher on the same settings page, add it again, and tag.
