# Releasing Codex For Copilot

This repository uses Release Please for semantic versioning and Microsoft Entra ID workload identity federation for keyless Visual Studio Marketplace publishing.

## Release flow

1. Merge normal pull requests into `master` with a Conventional Commit squash title.
2. Release Please creates or updates a release pull request containing:
   - the next version in `package.json` and `package-lock.json`;
   - the updated `.release-please-manifest.json`;
   - generated `CHANGELOG.md` entries.
3. Review and merge the release pull request.
4. The `Release` workflow:
   - creates a version tag and draft GitHub Release;
   - checks, compiles, and smoke-tests the extension;
   - packages the VSIX;
   - signs in to Microsoft Entra ID through GitHub OIDC;
   - publishes with `vsce --azure-credential`;
   - uploads the VSIX to the GitHub Release;
   - publishes the GitHub Release only after Marketplace publishing succeeds.

The release pull request remains the human approval point. A failed Marketplace publication leaves the GitHub Release as a draft.

## Repository settings prerequisite

In **Settings → Actions → General**, confirm that workflow permissions allow write access and enable **Allow GitHub Actions to create and approve pull requests**. Release Please needs this permission to create and update its release pull request.

Release Please uses the repository `GITHUB_TOKEN`, so the release pull request it creates does not automatically trigger another `pull_request` workflow. The publishing job runs the complete check, compile, and smoke-test sequence after the release pull request is merged. To validate the generated release branch before merging, manually run **Pull Request CI** and select the Release Please branch in the workflow branch selector.

## Version selection

Use Conventional Commit prefixes in the final pull request title used for squash merging:

| Pull request title | Version result |
| --- | --- |
| `fix: repair websocket reconnect` | Patch, for example `1.1.1` to `1.1.2` |
| `feat: add request compression` | Minor, for example `1.1.1` to `1.2.0` |
| `feat!: replace the authentication format` | Major, for example `1.1.1` to `2.0.0` |
| `docs:`, `test:`, `ci:`, `chore:` | No release by default |

Individual commits inside a pull request do not need to follow this format when the repository uses squash merging. The final squash title is what Release Please reads from `master`.

## One-time Microsoft Entra ID setup

The VS Code documentation currently demonstrates secure automated publishing with Azure Pipelines. This repository uses the same Microsoft Entra resource, Azure CLI credential flow, and `vsce --azure-credential`, while GitHub Actions supplies the short-lived identity through OIDC.

### 1. Create the GitHub environment

In the repository, open **Settings → Environments** and create an environment named exactly:

```text
marketplace
```

Optionally add required reviewers so every Marketplace deployment receives a second explicit approval.

### 2. Create a user-assigned managed identity

Create a user-assigned managed identity in the Microsoft Entra tenant connected to the Visual Studio Marketplace publisher. The Azure CLI example below uses placeholders:

```bash
RESOURCE_GROUP=<azure-resource-group>
IDENTITY_NAME=codex-for-copilot-marketplace
SUBSCRIPTION_ID=<azure-subscription-id>

az identity create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME"

AZURE_CLIENT_ID="$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME" \
  --query clientId \
  --output tsv)"

PRINCIPAL_ID="$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME" \
  --query principalId \
  --output tsv)"

AZURE_TENANT_ID="$(az account show --query tenantId --output tsv)"
```

Assign the minimum Azure role required for the identity to be usable by `azure/login`. The official VS Code publishing guide specifies `Reader`; scope it to the identity's resource group rather than the whole subscription when possible:

```bash
az role assignment create \
  --assignee-object-id "$PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role Reader \
  --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}"
```

### 3. Trust the GitHub environment through OIDC

Create a federated identity credential on the managed identity:

```bash
az identity federated-credential create \
  --resource-group "$RESOURCE_GROUP" \
  --identity-name "$IDENTITY_NAME" \
  --name github-marketplace \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:GaussianGuaicai/Codex-For-Copilot:environment:marketplace \
  --audiences api://AzureADTokenExchange
```

The subject is intentionally restricted to this repository and the `marketplace` GitHub environment. Do not broaden it to every branch or workflow.

### 4. Add GitHub environment variables

In **Settings → Environments → marketplace → Environment variables**, add:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Managed identity client ID |
| `AZURE_TENANT_ID` | Microsoft Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |

These identifiers are not credentials and do not need to be stored as secrets. No client secret is required.

### 5. Resolve the Marketplace identity profile ID

Run **Actions → Marketplace Identity Check → Run workflow**.

The workflow signs in using GitHub OIDC and writes the Azure DevOps/Marketplace identity profile ID to the workflow summary. It does not publish an extension.

### 6. Authorize the identity in Visual Studio Marketplace

Open the Visual Studio Marketplace publisher management page and select the `Gaussian` publisher. Add the profile ID from the previous step as a publisher member and assign the **Contributor** role.

Use Contributor rather than Owner so the automation can publish extensions without gaining publisher administration privileges.

### 7. Validate and retire the PAT

After this pull request is merged and the identity has been authorized:

1. Run **Actions → Release → Run workflow**.
2. Enter an existing release tag such as `v1.1.1` in `publish_tag` to exercise the build and Entra authentication path. `--skip-duplicate` makes an already-published Marketplace version safe to check.
3. Confirm that the `Publish to VS Code Marketplace` step authenticates successfully.
4. Delete the repository secret `VSCE_PAT`.

Keep the PAT until the Entra flow has completed successfully at least once. The release workflow no longer reads `VSCE_PAT`.

## Retrying a failed release

A failed publish can be retried from the failed GitHub Actions job. To retry later or from a fresh workflow run:

1. Open **Actions → Release → Run workflow**.
2. Enter the existing tag, for example `v1.2.0`, in `publish_tag`.
3. Run the workflow.

The workflow verifies that the tag matches `package.json`, rebuilds the exact tagged source, skips an already-published Marketplace version, replaces the VSIX asset, and publishes the draft GitHub Release.

## Security properties

- GitHub receives only a short-lived OIDC token.
- Microsoft Entra issues a short-lived Azure DevOps access token for resource `499b84ac-1321-427f-aa17-267ca6975798`.
- No Marketplace PAT or Entra client secret is stored in GitHub.
- The federated subject is restricted to the `marketplace` environment in this repository.
- `id-token: write` is granted only to the identity-check and publishing jobs.
- The Marketplace identity has Contributor rather than Owner access.
