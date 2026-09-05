# Internet Remote asset deployment

The Host and the online Remote use the same frontend files. After a Remote
change is pushed to `dev` or merged into `work/v0.8.0`, the **Sync Internet
Remote Production** workflow validates the frontend and requests a deployment
from a separately maintained private Worker repository. Pull requests only
validate; they never dispatch a deployment or receive the deployment token.

Automatic push synchronization is limited to the files copied by
`scripts/sync_internet_remote_assets.ps1`, the pictures it copies, and that
sync script itself. Changes only to tests, this workflow, or Host-only assets
do not request a production deployment. PR validation still covers those
frontend tests and workflow changes. Use **Run workflow** explicitly when a
configuration-only change needs a redeployment; its branch and credential
checks still apply.

The private repository mirrors the triggering source commit, commits the shared
assets, validates the Worker, and deploys to `rtc.kevinx96.icu`. Worker source,
Cloudflare credentials, and deployment configuration remain in that repository.
The application repository does not deploy the Worker itself.

## Public repository configuration

Configure these under **Settings → Secrets and variables → Actions** in each
public repository that should request production deployments:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `INTERNET_REMOTE_WORKER_REPOSITORY` | The private deployment repository, as `owner/repository` |
| Secret | `INTERNET_REMOTE_WORKER_TOKEN` | A GitHub token permitted to send dispatch events to that private repository |

A fine-grained token needs **Contents: read and write** on the selected private
repository. The public repository's built-in `GITHUB_TOKEN` cannot provide
cross-repository access. Prefer a dedicated token or GitHub App installation
credential rather than a maintainer's general-purpose credential. See the
[GitHub dispatch permission reference](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).

If the target variable is absent, validation still runs and deployment is
disabled. If the variable is present but the token is missing or invalid, the
dispatch job fails visibly. Fork PRs remain validation-only regardless of the
target repository's configuration. No Cloudflare secret is needed in Bilikara.

## Private deployment repository configuration

The receiver workflow must be present on the private repository's **default
branch** for `repository_dispatch` to run. It checks out the production Worker
branch and validates the dispatch's source repository, branch, and full commit
SHA before fetching any public source. It deploys that exact commit, and skips
requests superseded by newer Remote asset or sync-script changes. Later
test-only, workflow-only, or Host-only commits do not replace that deployment,
so the receiver must preserve the pending request's validated source SHA. Keep
its changed-input checks aligned with the public workflow's push allowlist.

Only one public source owns production at a time. The private repository's
`BILIKARA_PRODUCTION_REPOSITORY` and `BILIKARA_PRODUCTION_REF` variables select
either the fork's `dev` or upstream's `work/v0.8.0`. Events from the inactive
source are skipped with an explanation, so a fork push cannot overwrite an
upstream deployment after upstream takes over. Production deployments run
serially and are not cancelled halfway through publication.

The private repository alone holds `CLOUDFLARE_API_TOKEN` and the
`CLOUDFLARE_ACCOUNT_ID` variable. These are separate from the GitHub dispatch
credential. See [Cloudflare's GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

## Upstream handover

1. Merge the public workflow and this document into upstream `work/v0.8.0`.
2. Configure the target-repository variable and a dedicated dispatch-token secret
   in upstream. Secrets and variables are not copied by a PR or fork.
3. In the private repository, switch the production source to
   `VZRXS/bilikara` and `work/v0.8.0` together, then run its production workflow
   manually once. This publishes the branch head even if enabling the workflow
   did not produce a new frontend commit.
4. Later upstream Remote changes request deployment automatically. The fork's
   `codex/rtc-dev` continues to use the isolated `rtc-dev.kevinx96.icu` workflow
   and its private `dev` branch.

Updating online assets affects newly loaded Remote pages. It does not update
installed Host bundles. Changes to the Remote protocol must preserve support
for already-released Hosts or coordinate a compatible Host release first.
