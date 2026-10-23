import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlClient } from "@t3tools/source-control-core/client/definition";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

const kind = SourceControlProviderKind.make("cursor-origin");

export const definition = defineSourceControlClient({
  kind,
  label: "Cursor Origin",
  pickerLabel: "Cursor Origin",
  icon: "change-request",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "owner/repo",
  publicHost: "origin.cursor.com",
  publishDescription: "Cursor Origin",
  publishHost: () => "origin.cursor.com",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number }) =>
    `https://cursor.com/codebase/${repository}/pull/${number}`,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "enable-auto-merge",
    "disable-auto-merge",
  ] as const),
  checkoutCommand: ({ number }) => `origin pr checkout ${number}`,
  checkoutCommandArgument: () => null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  isChangeRequestReference: () => false,
  changeRequestUrlHost: () => "origin.cursor.com",
  checkoutChangeRequestHost: () => "origin.cursor.com",
  isChangeRequestUrl: (url) => {
    try {
      return new URL(url).hostname === "cursor.com" && parseChangeRequestUrl(url) !== null;
    } catch {
      return false;
    }
  },
  isChangeRequestInRepository: (identity, link) =>
    link.host === "origin.cursor.com" &&
    identity.canonicalKey.toLowerCase() === `origin.cursor.com/${link.repository}`,
  canReadChangeRequestOnHost: (identity, link) =>
    identity.canonicalKey.startsWith("origin.cursor.com/") && link.host === "origin.cursor.com",
});
