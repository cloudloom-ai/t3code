import {
  SourceControlProviderKind,
  resolvePullRequestAuthorFilter,
  type PullRequestCapabilities,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type ProviderRepositoryRef,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as OriginCli from "./OriginCli.ts";
import * as Json from "./originPullRequests.ts";
import { definition } from "../client/definition.ts";

const kind = SourceControlProviderKind.make("cursor-origin");
const capabilities: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash"],
  search: false,
  reactions: false,
  labels: true,
  stacks: false,
  stackActions: false,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: true, listCandidates: false },
  edit: { changeRequest: true, comment: true },
};
const Identity = Schema.Struct({
  authenticated: Schema.Boolean,
  account: Schema.NullOr(
    Schema.Struct({
      publicUserId: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    }),
  ),
});
const decodeIdentity = Schema.decodeEffect(Schema.fromJsonString(Identity));
const Permission = Schema.Struct({ permission: Schema.String });
const Repository = Schema.Struct({
  allowMergeCommit: Schema.Boolean,
  allowSquashMerge: Schema.Boolean,
});
const Labels = Schema.Struct({
  labels: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      color: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
  nextPageToken: Schema.optional(Schema.String),
});
const failed = (operation: string, detail: string) =>
  new PullRequestProviderError({ provider: kind, operation, reason: "failed", detail });
const encodedRepository = (repository: string) =>
  repository.split("/").map(encodeURIComponent).join("/");
const basePath = (input: ProviderRepositoryRef) => `/repos/${encodedRepository(input.repository)}`;
const pullPath = (input: ProviderRepositoryRef & { readonly number: number }) =>
  `${basePath(input)}/pulls/${input.number}`;

export const make = Effect.gen(function* () {
  const cli = yield* OriginCli.OriginCli;
  const read = <A>(
    operation: string,
    input: { readonly cwd: string; readonly host?: string },
    path: string,
    schema: Schema.Decoder<A>,
    method?: "POST" | "PATCH" | "PUT" | "DELETE",
    body?: object,
  ) => {
    if (input.host !== undefined && input.host !== "origin.cursor.com")
      return Effect.fail(failed(operation, "Origin requests must target origin.cursor.com."));
    return OriginCli.request(
      cli,
      { cwd: input.cwd, operation, path, ...(method ? { method } : {}), ...(body ? { body } : {}) },
      schema,
    );
  };
  const send = (
    operation: string,
    input: ProviderRepositoryRef,
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body: object,
  ) => read(operation, input, path, Schema.Unknown, method, body).pipe(Effect.asVoid);
  const pages = Effect.fn("OriginPullRequestProvider.pages")(function* <
    A,
    P extends { readonly nextPageToken?: string | undefined },
  >(
    operation: string,
    input: ProviderRepositoryRef,
    path: string,
    schema: Schema.Decoder<P>,
    select: (page: P) => ReadonlyArray<A>,
  ) {
    const items: A[] = [];
    const seen = new Set<string>();
    let token = "";
    for (let index = 0; index < 10; index++) {
      const query = new URLSearchParams({ pageSize: "100" });
      if (token) query.set("pageToken", token);
      const page = yield* read(
        operation,
        input,
        `${path}${path.includes("?") ? "&" : "?"}${query}`,
        schema,
      );
      items.push(...select(page));
      token = page.nextPageToken ?? "";
      if (!token) return { items, truncated: false };
      if (seen.has(token)) return { items, truncated: true };
      seen.add(token);
    }
    return { items, truncated: true };
  });
  const identity = Effect.fn("OriginPullRequestProvider.identity")(function* (input: {
    readonly cwd: string;
    readonly host?: string;
  }) {
    if (input.host !== undefined && input.host !== "origin.cursor.com")
      return yield* failed("getViewer", "Origin requests must target origin.cursor.com.");
    const stdout = yield* cli.run({
      cwd: input.cwd,
      operation: "getViewer",
      args: ["auth", "status", "--json", "authenticated,account"],
    });
    const decoded = yield* decodeIdentity(stdout).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: kind,
            operation: "getViewer",
            reason: "failed",
            detail: "Origin did not report the signed-in account.",
            cause,
          }),
      ),
    );
    if (!decoded.authenticated || !decoded.account?.publicUserId)
      return yield* new PullRequestProviderError({
        provider: kind,
        operation: "getViewer",
        reason: decoded.authenticated ? "failed" : "unauthenticated",
        detail: decoded.authenticated
          ? "Origin could not resolve the signed-in account. Check server connectivity and try again."
          : "Run origin auth login on the server and rescan Source Control settings.",
      });
    return decoded.account.publicUserId;
  });
  const readPull = (
    operation: string,
    input: ProviderRepositoryRef & { readonly number: number },
  ) => read(operation, input, pullPath(input), Json.Pull);
  const normalize = (pull: typeof Json.Pull.Type, repository: string) =>
    Effect.try({
      try: () => Json.summary(pull, repository),
      catch: (cause) =>
        new PullRequestProviderError({
          provider: kind,
          operation: "readPull",
          reason: "failed",
          detail: "Origin returned an invalid pull request.",
          cause,
        }),
    });
  const access = Effect.fn("OriginPullRequestProvider.access")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    pull: typeof Json.Pull.Type,
  ) {
    const viewer = yield* identity(input);
    const permission = yield* read(
      "getViewerPermissions",
      input,
      `${basePath(input)}/collaborators/${encodeURIComponent(viewer)}/permission`,
      Permission,
    );
    return Json.permissions({
      canWrite: permission.permission === "write" || permission.permission === "admin",
      own: pull.author?.user?.id === viewer,
      pull,
    });
  });
  const provider: PullRequestProviderApi = {
    kind,
    capabilities,
    getViewer: identity,
    listChangeRequests: Effect.fn("OriginPullRequestProvider.listChangeRequests")(
      function* (input) {
        const limit = Math.max(1, input.limit);
        const query = new URLSearchParams({
          state: input.state,
          sortBy: "updated",
          direction: "desc",
        });
        if (input.involvement === "authored") query.set("author", input.viewer);
        if (input.filters?.author)
          query.set("author", resolvePullRequestAuthorFilter(input.filters.author, input.viewer));
        const items: ReturnType<typeof Json.summary>[] = [];
        let token = input.cursor?.pageToken ?? "";
        if (input.cursor && !token)
          return yield* failed(
            "listChangeRequests",
            "Refresh the Origin pull request list to restart pagination.",
          );
        const seen = new Set<string>(token ? [token] : []);
        for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
          query.set("pageSize", String(Math.min(100, limit - items.length)));
          if (token) query.set("pageToken", token);
          const page = yield* read(
            "listChangeRequests",
            input,
            `${basePath(input)}/pulls?${query}`,
            Json.Pulls,
          );
          for (const pull of page.pullRequests)
            items.push(yield* normalize(pull, input.repository));
          token = page.nextPageToken ?? "";
          if (token && seen.has(token))
            return yield* failed(
              "listChangeRequests",
              "Origin returned a repeated pagination token.",
            );
          if (!token || items.length >= limit) break;
          seen.add(token);
        }
        // The API has no reviewer filter. Keep reads bounded to the requested slice.
        const slice = items.slice(0, limit);
        const enriched = yield* Effect.forEach(
          slice,
          (item) =>
            read(
              "listChangeRequests",
              input,
              `${basePath(input)}/pulls/${item.number}/requested_reviewers`,
              Json.Reviewers,
            ).pipe(
              Effect.map((reviewers) => ({
                ...item,
                reviewRequestLogins: [
                  ...reviewers.users.map((user) => user.id),
                  ...reviewers.groups.map((group) => group.id),
                ],
              })),
            ),
          { concurrency: 4 },
        );
        return {
          items: enriched,
          truncated: !!token,
          continues: true,
          ...(token ? { nextPageToken: token } : {}),
        };
      },
    ),
    getChangeRequestSummary: Effect.fn("OriginPullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        return yield* normalize(
          yield* readPull("getChangeRequestSummary", input),
          input.repository,
        );
      },
    ),
    getChangeRequestChecks: Effect.fn("OriginPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const pull = yield* readPull("getChangeRequestChecks", input);
        const result = yield* pages(
          "getChangeRequestChecks",
          input,
          `${basePath(input)}/commits/${encodeURIComponent(pull.head.sha)}/check-runs`,
          Json.Checks,
          (page) => page.checkRuns,
        );
        return {
          state: (yield* normalize(pull, input.repository)).state,
          checks: [
            ...result.items.map(Json.check),
            ...(result.truncated
              ? [
                  {
                    name: "More Origin checks",
                    status: "pending" as const,
                    description: "The Origin checks response exceeded T3's read limit.",
                    url: null,
                  },
                ]
              : []),
          ],
        };
      },
    ),
    getChangeRequest: Effect.fn("OriginPullRequestProvider.getChangeRequest")(function* (input) {
      const pull = yield* readPull("getChangeRequest", input);
      const [permission, repository, mergeability, checks, reviewers] = yield* Effect.all(
        [
          access(input, pull),
          read("getChangeRequest", input, basePath(input), Repository),
          read(
            "getChangeRequest",
            input,
            `${pullPath(input)}/mergeability?expectedHeadSha=${encodeURIComponent(pull.head.sha)}`,
            Json.Mergeability,
          ),
          pages(
            "getChangeRequest",
            input,
            `${basePath(input)}/commits/${encodeURIComponent(pull.head.sha)}/check-runs`,
            Json.Checks,
            (page) => page.checkRuns,
          ),
          read("getChangeRequest", input, `${pullPath(input)}/requested_reviewers`, Json.Reviewers),
        ],
        { concurrency: 4 },
      );
      const normalizedChecks = checks.items.map((run) => Json.check(run));
      return {
        ...(yield* normalize(pull, input.repository)),
        headSha: pull.head.sha,
        body: pull.body,
        changedFiles: pull.changedFiles,
        closedAt: pull.closedAt ?? null,
        mergedAt: pull.mergedAt ?? null,
        reviewers: reviewers.users.map((user) => Json.actor({ user })!),
        reviewRequestLogins: reviewers.users.map((user) => user.id),
        checks: normalizedChecks,
        ...(normalizedChecks.length > 0
          ? {
              checksState: normalizedChecks.some(
                (check) => check.status === "failure" || check.status === "action-required",
              )
                ? ("failing" as const)
                : checks.truncated || normalizedChecks.some((check) => check.status === "pending")
                  ? ("pending" as const)
                  : ("passing" as const),
            }
          : {}),
        mergeability:
          mergeability.verdict === "mergeable"
            ? "mergeable"
            : mergeability.blockers.some((blocker) => blocker.kind === "merge_conflict")
              ? "conflicting"
              : "unknown",
        mergeCapabilities: {
          merge: repository.allowMergeCommit,
          squash: repository.allowSquashMerge,
          rebase: false,
        },
        viewerPermissions: permission,
        autoMergeEnabled: !!pull.autoMerge,
        ...(pull.autoMerge?.mergeMethod === "merge" || pull.autoMerge?.mergeMethod === "squash"
          ? { autoMergeMethod: pull.autoMerge.mergeMethod }
          : {}),
      };
    }),
    getChangeRequestActivity: Effect.fn("OriginPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const pull = yield* readPull("getChangeRequestActivity", input);
        const [comments, reviews, commits] = yield* Effect.all(
          [
            pages(
              "getChangeRequestActivity",
              input,
              `${pullPath(input)}/comments`,
              Json.Comments,
              (page) => page.comments,
            ),
            pages(
              "getChangeRequestActivity",
              input,
              `${pullPath(input)}/reviews`,
              Json.Reviews,
              (page) => page.reviews,
            ),
            pages(
              "getChangeRequestActivity",
              input,
              `${pullPath(input)}/commits`,
              Json.Commits,
              (page) => page.commits,
            ),
          ],
          { concurrency: 3 },
        );
        return Json.activity({
          comments: comments.items,
          reviews: reviews.items,
          commits: commits.items,
          headSha: pull.head.sha,
          truncated: comments.truncated || reviews.truncated,
        });
      },
    ),
    getViewerPermissions: Effect.fn("OriginPullRequestProvider.getViewerPermissions")(
      function* (input) {
        return yield* access(input, yield* readPull("getViewerPermissions", input));
      },
    ),
    getDiff: Effect.fn("OriginPullRequestProvider.getDiff")(function* (input) {
      if (input.commit)
        return yield* failed("getDiff", "Origin commit-specific diffs are not available here.");
      const query = new URLSearchParams({ pageSize: "50" });
      if (input.cursor) query.set("pageToken", input.cursor);
      const result = yield* read("getDiff", input, `${pullPath(input)}/files?${query}`, Json.Files);
      const quoted = (path: string) => JSON.stringify(path);
      const patch = result.files
        .map((file) => {
          const previous = file.previousFilename || file.filename;
          const header = `diff --git ${quoted(`a/${previous}`)} ${quoted(`b/${file.filename}`)}\n`;
          const mode =
            file.status === "added"
              ? "new file mode 100644\n"
              : file.status === "removed"
                ? "deleted file mode 100644\n"
                : file.status === "renamed"
                  ? // Origin omits similarity; the renderer uses this marker to retain rename paths.
                    `similarity index ${file.additions === 0 && file.deletions === 0 ? 100 : 0}%\nrename from ${quoted(previous)}\nrename to ${quoted(file.filename)}\n`
                  : "";
          return `${header}${mode}${file.patch ? `--- ${file.status === "added" ? "/dev/null" : quoted(`a/${previous}`)}\n+++ ${file.status === "removed" ? "/dev/null" : quoted(`b/${file.filename}`)}\n${file.patch}\n` : ""}`;
        })
        .join("");
      return {
        patch,
        truncated: result.files.some(
          (file) =>
            !file.patch && (file.status === "modified" || file.additions > 0 || file.deletions > 0),
        ),
        omittedFileStats: result.files
          .filter((file) => !file.patch)
          .map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
          })),
        nextCursor: result.nextPageToken || null,
      };
    }),
    runAction: Effect.fn("OriginPullRequestProvider.runAction")(function* (input) {
      if (input.stackNumber !== undefined)
        return yield* failed(input.action, "Origin stack actions are not available here.");
      if (
        (input.action === "merge" || input.action === "enable-auto-merge") &&
        input.mergeMethod === "rebase"
      )
        return yield* failed(input.action, "Origin supports merge and squash merges.");
      const pull = yield* readPull(input.action, input);
      if (input.action === "merge" && pull.merged) return;
      const permissions = yield* access(input, pull);
      if (!permissions.actions.includes(input.action))
        return yield* failed(
          input.action,
          pull.stack?.parentPullRequest
            ? "Merge stacked pull requests in Cursor Origin to review the entire merge prefix."
            : "Origin does not allow this action for the current account and pull request state.",
        );
      switch (input.action) {
        case "merge":
          if (input.mergeMethod === "rebase")
            return yield* failed("merge", "Origin supports merge and squash merges.");
          return yield* send("merge", input, `${pullPath(input)}/merge`, "POST", {
            expectedHeadSha: pull.head.sha,
            ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
          });
        case "ready":
        case "draft":
        case "close":
        case "reopen":
          return yield* send(
            input.action,
            input,
            pullPath(input),
            "PATCH",
            input.action === "close"
              ? { state: "closed" }
              : input.action === "reopen"
                ? { state: "open", draft: pull.draft }
                : { draft: input.action === "draft" },
          );
        case "enable-auto-merge":
        case "disable-auto-merge":
          return yield* send(
            input.action,
            input,
            `${pullPath(input)}/auto_merge`,
            input.action === "enable-auto-merge" ? "PUT" : "DELETE",
            input.action === "enable-auto-merge" && input.mergeMethod
              ? { mergeMethod: input.mergeMethod }
              : {},
          );
        default:
          return yield* failed(input.action, "Origin does not support this action in T3.");
      }
    }),
    updateChangeRequest: (input) =>
      send("updateChangeRequest", input, pullPath(input), "PATCH", {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
      }),
    updateComment: (input) =>
      send(
        "updateComment",
        input,
        `${basePath(input)}/pulls/comments/${encodeURIComponent(input.commentId)}`,
        "PATCH",
        { body: input.body },
      ),
    comment: (input) =>
      send("comment", input, `${pullPath(input)}/comments`, "POST", { body: input.body }),
    submitReview: Effect.fn("OriginPullRequestProvider.submitReview")(function* (input) {
      const pull = yield* readPull("submitReview", input);
      return yield* send("submitReview", input, `${pullPath(input)}/reviews`, "POST", {
        verdict: input.verdict === "request-changes" ? "request_changes" : input.verdict,
        body: input.body,
        versionNumber: pull.version.number,
        comments: input.comments.map((comment) => {
          const position = comment.position;
          const side =
            position.kind === "deleted"
              ? "left"
              : position.kind === "added"
                ? "right"
                : position.side;
          const line =
            position.kind === "deleted"
              ? position.oldLine
              : position.kind === "added"
                ? position.newLine
                : side === "left"
                  ? position.oldLine
                  : position.newLine;
          return { body: comment.body, inline: { path: comment.path, side, startLine: line } };
        }),
      });
    }),
    listReviewerCandidates: () =>
      Effect.fail(
        failed(
          "listReviewerCandidates",
          "Origin does not expose reviewer candidate discovery. Enter the reviewer's public user ID or email.",
        ),
      ),
    setReviewerRequest: (input) =>
      send(
        "setReviewerRequest",
        input,
        `${pullPath(input)}/requested_reviewers`,
        input.requested ? "POST" : "DELETE",
        {
          users: input.reviewers
            .filter((reviewer) => reviewer.kind === "user")
            .map((reviewer) => reviewer.id),
          groups: input.reviewers
            .filter((reviewer) => reviewer.kind === "team")
            .map((reviewer) => reviewer.id),
        },
      ),
    replyToThread: (input) =>
      send("replyToThread", input, `${pullPath(input)}/comments`, "POST", {
        body: input.body,
        threadId: input.threadId,
      }),
    setReaction: () =>
      Effect.fail(
        failed("setReaction", "Origin does not expose pull request description reactions."),
      ),
    setThreadResolution: (input) =>
      send(
        "setThreadResolution",
        input,
        `${basePath(input)}/pulls/threads/${encodeURIComponent(input.threadId)}`,
        "PATCH",
        { resolved: input.resolved },
      ),
    listLabelCandidates: Effect.fn("OriginPullRequestProvider.listLabelCandidates")(
      function* (input) {
        const [pull, labels] = yield* Effect.all(
          [
            readPull("listLabelCandidates", input),
            pages(
              "listLabelCandidates",
              input,
              `${basePath(input)}/labels`,
              Labels,
              (page) => page.labels,
            ),
          ],
          { concurrency: 2 },
        );
        return {
          candidates: labels.items.map((label) => ({
            name: label.name,
            color: label.color ?? null,
            description: label.description ?? null,
            isApplied: (pull.labels ?? []).some((applied) => applied.name === label.name),
          })),
          truncated: labels.truncated,
        };
      },
    ),
    setLabels: (input) =>
      input.applied
        ? send("setLabels", input, `${pullPath(input)}/labels`, "POST", { labels: input.labels })
        : Effect.forEach(
            input.labels,
            (label) =>
              send(
                "setLabels",
                input,
                `${pullPath(input)}/labels/${encodeURIComponent(label)}`,
                "DELETE",
                {},
              ),
            { concurrency: 1 },
          ).pipe(Effect.asVoid),
  };
  return provider;
});
