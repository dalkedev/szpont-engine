# Releases and container images

A release is a versioned public source snapshot and a container image. It does not update an existing private deployment automatically. The [changelog](../CHANGELOG.md) records user-visible changes; the [Docker guide](docker.md) explains initial setup and private volumes.

## Pull a release

```sh
docker pull ghcr.io/dalkedev/szpont-engine:0.6.1
docker buildx imagetools inspect ghcr.io/dalkedev/szpont-engine:0.6.1
```

The release workflow publishes Linux `amd64` and `arm64` variants. A stable release publishes an exact version tag, a minor-series tag, `latest`, and `sha-<first 12 characters of commit>`. For example, `v0.6.1` produces `0.6.1`, `0.6`, `latest`, and its revision tag. A prerelease such as `v0.7.0-rc.1` publishes only its exact prerelease and revision tags; it cannot move `latest` or a stable minor-series tag.

Tags are convenient aliases. For repeatable deployments, copy the full `ghcr.io/dalkedev/szpont-engine@sha256:...` reference from the successful workflow summary or manifest inspection and pin that digest in your deployment. The OCI labels identify the source repository, exact revision, version, and MIT license. The published image also includes BuildKit provenance and an SBOM.

The engine image contains no browser profile or real account session. Version 0.6.1 packages and verifies **Codex only**; it rejects `SZPONT_RUNNER=claude` and `opencode` before initialization writes. Claude Code and OpenCode are [experimental host adapters](runners.md), requiring their own installed CLI, private authentication, permissions and acceptance checks. The optional Camoufox desktop/browser service is outside this image. A release does not supply model access or account allowances.

Version 0.5.0 introduced [private Discord image input](image-input.md) for Codex, including
resumed turns. The other host adapters explicitly reject images. SQLite snapshots
now include attachment bytes; keep them private. Version 0.6.0 added [guided integration setup](integrations.md) and recovery that can
continue the saved session with a fresh, explicit work budget. It retains schema 4
and does not alter a private deployment or backport its custom integrations.

Version 0.6.1 adds `!queue` for current-thread waiting reasons and fixes status, result
readback and recovery suggestions to use durable acceptance order when the host clock
moves backwards. It does not introduce another worker or a state migration.

## Maintainer release process

1. Prepare the intended changes in a reviewed pull request. Keep all real state and owner material outside the source tree.
2. Set the same version in the root `package.json`, `apps/discord-agent/package.json`, both root-version fields of `apps/discord-agent/package-lock.json`, `packages/browser/pyproject.toml`, the `__version__` constant in `packages/browser/src/szpont_browser/__init__.py`, and the `szpont-browser` project entry in `packages/browser/uv.lock`. Set the Dockerfile `VERSION` default and Compose image default to the same release version. Update `CHANGELOG.md` with the actual changes and date. Check the Python lock with `uv lock --check --offline` from `packages/browser`.
3. Review the diff and wait for the normal checks on the exact pull-request head. Run the container smoke test locally when Docker is available, then merge normally and verify the resulting `main` commit before tagging.
4. Create and push a fresh version tag on that commit. Never move an existing release tag.

```sh
git switch main
git pull --ff-only
git tag -a v0.6.1 -m 'Szpont Engine 0.6.1'
git push origin refs/tags/v0.6.1
```

The [release workflow](../.github/workflows/release.yml) runs only on `v*` tag pushes. It first requires the tagged commit to be reachable from `main`, validates all package and project-lock versions, checks the public tree, and runs the locked engine and browser suites. Each native amd64/arm64 runner then builds its OCI archive once, including provenance and an SBOM, and loads that archive's runtime for the offline smoke test. A configuration-digest check binds the loaded runtime (including its filesystem layer identities) to the OCI archive. Runtime state is created in throwaway volumes and is never included in the archive.

Only the original tested archives and their digest reports are retained as workflow artifacts, for one day. A separate publishing job receives `packages: write` after all checks succeed. It revalidates the archive hashes, labels, runtime and attestation subjects, copies every manifest with `skopeo --preserve-digests`, and combines the unchanged amd64/arm64 runtime and attestation manifests into the release index. It does not rebuild the application or reinstall its dependencies. The final index is checked against the complete tested manifest set before its digest is recorded. Publishing uses the job's short-lived GitHub token; no personal registry token is needed. If retained artifacts have expired, rerun the complete workflow so both architectures are rebuilt and retested.

After the workflow succeeds, inspect the published manifest and digest, pull the exact image without authentication to confirm public availability, and create the GitHub release with the relevant changelog entry and immutable image reference. The workflow deliberately does not create a release announcement before the image has been verified. GitHub may initially create a GHCR package as private; check its package visibility for the first publication before documenting anonymous installation.

The tag validator accepts SemVer versions with an optional prerelease, without build metadata (`+...`, which is not a Docker tag character). Release metadata and tag-selection behavior have their own offline test:

```sh
node --test scripts/release-metadata.test.mjs scripts/release-oci.test.mjs
```

Official references: [Docker OCI exports](https://docs.docker.com/build/exporters/oci-docker/), [BuildKit attestations](https://docs.docker.com/build/ci/github-actions/attestations/), [digest-preserving Skopeo copy](https://github.com/podman-container-tools/skopeo/blob/main/docs/skopeo-copy.1.md), [manifest composition](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/), and [GitHub package publishing](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Upgrade and rollback

Record the current image digest and stop the engine before taking a coordinated backup of its private state and workspace. Keep runner authentication and browser-profile backups private and separate. Start the desired pinned image with the same configured volumes, then inspect its logs and queue status before sending a synthetic owner task. A successful image build or offline smoke test does not establish Discord connectivity, account validity or live model access.

Do not run two engine instances against the same SQLite state at once. Version 0.6.1 retains **schema 4**, introduced in 0.5.0, and migrates public schemas 0, 1, 2 and 3 to that schema. Existing provider bindings and sessions are preserved; pre-schema-3 jobs and conversations retain Codex bindings, including conversations whose session has not started; changing `SZPONT_RUNNER` never converts them to another provider. New threads use the configured default. Session reset retains the thread's provider, and recovery retains the original job's provider.

| Engine version | Public SQLite schema |
| --- | --- |
| 0.2.x | 0 |
| 0.3.0 | 1 |
| 0.3.1 | 2 |
| 0.4.0 | 3 |
| 0.5.0–0.6.1 | 4 |

Before upgrading, create and verify a pre-upgrade snapshot using the [state backup guide](state-backups.md), and retain the matching workspace checkpoint and image digest. The 0.4.0 engine rejects schema 4, and 0.3.x rejects schema 3 and later. To roll back across an incompatible schema, stop the current engine, restore the compatible pre-upgrade snapshot into a new private state location, reconcile jobs and external actions accepted after that snapshot, and switch the matching binary and workspace together. Never lower `PRAGMA user_version` or remove provider columns or image tables as a downgrade shortcut.

Versions 0.5.0 through 0.6.1 share schema 4, but a rollback still requires reviewing recovery jobs and external actions accepted by the newer engine. Retain a coordinated pre-upgrade snapshot, workspace checkpoint and image digest rather than treating schema compatibility as an automatic replay guarantee.

The 0.2 engine predates the version guard and cannot preserve later workflow or provider semantics. It must never open migrated state. A rollback restores earlier database contents; it does not undo files, posts, deployments or other external effects. Public and private-deployment databases are not interchangeable.

## Unreleased source: supervised goals

The goal-loop change migrates public schemas 0–4 to schema 5 and adds
[`!goal` / `!loop`](supervised-goals.md). Versioned 0.6.1 statements above remain
historical. Retain a pre-upgrade schema-4 snapshot for rollback to 0.6.1; a
0.6.1 binary cannot open schema 5. No release or image is implied by this source
change.
