import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer, processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as OriginCli from "./OriginCli.ts";
import * as Origin from "./OriginPullRequestProvider.ts";

const ref = { cwd: "/repo", host: "origin.cursor.com", repository: "acme/rocket", number: 17 };
const sha = "a".repeat(40);
const pull = {
  number: "17",
  title: "Launch",
  body: "Description",
  state: "open",
  merged: false,
  draft: false,
  head: { ref: "feature", sha },
  base: { ref: "main", sha: "b".repeat(40) },
  author: { user: { id: "user_author", displayName: "Author" } },
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-22T00:00:00Z",
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  version: { number: "3" },
  labels: [{ name: "bug", color: "ff0000" }],
};
type Input = SourceControlHost.SourceControlProcessInput;
const testLayer = (respond: (input: Input) => unknown = () => undefined) =>
  OriginCli.layer.pipe(
    Layer.provide(
      layer({
        process: {
          run: (input) => {
            const response = respond(input);
            if (response !== undefined)
              return Effect.succeed(
                processOutput(typeof response === "string" ? response : JSON.stringify(response)),
              );
            if (input.args[0] === "auth")
              return Effect.succeed(
                processOutput(
                  JSON.stringify({ authenticated: true, account: { publicUserId: "user_viewer" } }),
                ),
              );
            const path = input.args[1] ?? "";
            if (path === "/repos/acme/rocket/pulls/17")
              return Effect.succeed(processOutput(JSON.stringify(pull)));
            if (path.endsWith("/permission"))
              return Effect.succeed(processOutput('{"permission":"write"}'));
            if (path === "/repos/acme/rocket")
              return Effect.succeed(
                processOutput('{"allowMergeCommit":true,"allowSquashMerge":true}'),
              );
            if (path.includes("/mergeability"))
              return Effect.succeed(processOutput('{"verdict":"mergeable","blockers":[]}'));
            if (path.includes("/check-runs"))
              return Effect.succeed(processOutput('{"checkRuns":[]}'));
            if (path.includes("/requested_reviewers"))
              return Effect.succeed(processOutput('{"users":[],"groups":[]}'));
            return Effect.die(`Unexpected Origin request ${input.args.join(" ")}`);
          },
        },
      }),
    ),
  );

const withProvider = <A, E>(
  use: (
    provider: import("@t3tools/source-control-core/server/PullRequestProvider").PullRequestProviderApi,
  ) => Effect.Effect<A, E>,
  respond?: (input: Input) => unknown,
) => Origin.make.pipe(Effect.flatMap(use), Effect.provide(testLayer(respond)));

describe("Origin PR integration", () => {
  it.effect("shows PR details, reviewer identity, checks, and allowed merge methods", () =>
    withProvider(
      (provider) =>
        Effect.gen(function* () {
          const detail = yield* provider.getChangeRequest(ref);
          expect(detail).toMatchObject({
            number: 17,
            body: "Description",
            headSha: sha,
            author: { login: "user_author", name: "Author" },
            mergeability: "mergeable",
            mergeCapabilities: { merge: true, squash: true, rebase: false },
            autoMergeEnabled: false,
          });
          expect(detail.viewerPermissions.actions).toContain("merge");
          expect(detail.checks).toMatchObject([{ name: "CI", status: "pending" }]);
          expect(detail.checksState).toBe("pending");
        }),
      (input) =>
        input.args[1]?.includes("/check-runs")
          ? { checkRuns: [{ name: "CI", status: "rerequested", conclusion: "success" }] }
          : undefined,
    ),
  );

  it.effect("paginates PR listings and preserves merged state", () => {
    const paths: string[] = [];
    return withProvider(
      (provider) =>
        Effect.gen(function* () {
          const result = yield* provider.listChangeRequests({
            ...ref,
            state: "all",
            involvement: "all",
            viewer: "user_viewer",
            limit: 2,
          });
          expect(result.items.map((item) => [item.number, item.state])).toEqual([
            [17, "open"],
            [18, "merged"],
          ]);
          expect(result.truncated).toBe(false);
          expect(paths.some((path) => path.includes("pageToken=next"))).toBe(true);
        }),
      (input) => {
        const path = input.args[1] ?? "";
        if (!path.startsWith("/repos/acme/rocket/pulls?")) return undefined;
        paths.push(path);
        return path.includes("pageToken=next")
          ? { pullRequests: [{ ...pull, number: "18", state: "closed", merged: true }] }
          : { pullRequests: [pull], nextPageToken: "next" };
      },
    );
  });

  it.effect("groups inline comments, preserves resolution, and displays review decisions", () =>
    withProvider(
      (provider) =>
        Effect.gen(function* () {
          const activity = yield* provider.getChangeRequestActivity(ref);
          expect(activity.comments).toMatchObject([
            { id: "general", kind: "issue-comment", author: { login: "user_viewer" } },
            { id: "review", kind: "review", reviewState: "APPROVED" },
          ]);
          expect(activity.reviewThreads).toMatchObject([
            {
              id: "thread",
              path: "src/a.ts",
              line: 5,
              side: "right",
              isResolved: true,
              isOutdated: false,
              comments: [{ id: "inline" }, { id: "reply" }],
            },
          ]);
          expect(activity.commits).toMatchObject([{ oid: sha, messageHeadline: "Launch" }]);
        }),
      (input) => {
        const path = input.args[1] ?? "";
        const comment = {
          id: "inline",
          body: "Review",
          author: { user: { id: "user_viewer" } },
          createdAt: pull.createdAt,
          thread: {
            id: "thread",
            path: "src/a.ts",
            side: "right",
            startLine: 5,
            endLine: 0,
            resolvedAt: pull.updatedAt,
            version: { headSha: sha },
          },
        };
        if (path.includes("/comments?"))
          return {
            comments: [
              {
                ...comment,
                id: "general",
                thread: { ...comment.thread, id: "discussion", path: "" },
              },
              comment,
              { ...comment, id: "reply" },
            ],
          };
        if (path.includes("/reviews?"))
          return {
            reviews: [
              { id: "review", body: "Looks good", verdict: "approve", submittedAt: pull.updatedAt },
            ],
          };
        if (path.includes("/commits?"))
          return {
            commits: [
              { sha, commit: { message: "Launch\n\nBody", committer: { date: pull.createdAt } } },
            ],
          };
        return undefined;
      },
    ),
  );

  it.effect("builds paginated diffs with rename headers and marks omitted patches", () =>
    withProvider(
      (provider) =>
        Effect.gen(function* () {
          const diff = yield* provider.getDiff({ ...ref, cursor: "next" });
          expect(diff.patch).toContain('rename from "old.ts"');
          expect(diff.patch).toContain('+++ "b/new.ts"');
          expect(diff.patch).toContain("@@ -1 +1 @@");
          expect(diff.truncated).toBe(true);
          expect(diff.nextCursor).toBe("later");
          expect(diff.omittedFileStats).toContainEqual({
            path: "large.ts",
            additions: 200,
            deletions: 0,
          });
        }),
      (input) =>
        input.args[1]?.includes("/files?")
          ? {
              files: [
                {
                  filename: "new.ts",
                  previousFilename: "old.ts",
                  status: "renamed",
                  additions: 1,
                  deletions: 1,
                  patch: "@@ -1 +1 @@\n-old\n+new",
                },
                { filename: "large.ts", status: "modified", additions: 200, deletions: 0 },
              ],
              nextPageToken: "later",
            }
          : undefined,
    ),
  );

  it.effect("guards merges with the head SHA and applies the selected method", () => {
    let body: unknown;
    return withProvider(
      (provider) =>
        Effect.gen(function* () {
          yield* provider.runAction({ ...ref, action: "merge", mergeMethod: "squash" });
          expect(body).toEqual({ expectedHeadSha: sha, mergeMethod: "squash" });
        }),
      (input) => {
        if (input.args[1]?.endsWith("/merge")) {
          body = JSON.parse(input.stdin ?? "{}");
          return {};
        }
        return undefined;
      },
    );
  });

  it.effect("refuses a single-PR merge that would merge a stack prefix", () =>
    withProvider(
      (provider) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(provider.runAction({ ...ref, action: "merge" }));
          expect(error.detail).toContain("entire merge prefix");
        }),
      (input) =>
        input.args[1] === "/repos/acme/rocket/pulls/17"
          ? { ...pull, stack: { id: "stack", parentPullRequest: { number: "16" } } }
          : undefined,
    ),
  );

  it.effect("keeps read-only users from merging while allowing comments and reviews", () =>
    withProvider(
      (provider) =>
        Effect.gen(function* () {
          const permissions = yield* provider.getViewerPermissions(ref);
          expect(permissions.actions).toEqual([]);
          expect(permissions.comment).toBe(true);
          expect(permissions.verdicts).toContain("approve");
        }),
      (input) => (input.args[1]?.endsWith("/permission") ? { permission: "read" } : undefined),
    ),
  );

  it.effect("supports reverse lifecycle actions and auto-merge using documented methods", () => {
    const writes: Array<{ method: string | undefined; path: string; body: unknown }> = [];
    return withProvider(
      (provider) =>
        Effect.gen(function* () {
          for (const action of ["close", "draft", "enable-auto-merge"] as const)
            yield* provider.runAction({ ...ref, action });
          expect(writes).toEqual([
            { method: "PATCH", path: "/repos/acme/rocket/pulls/17", body: { state: "closed" } },
            { method: "PATCH", path: "/repos/acme/rocket/pulls/17", body: { draft: true } },
            { method: "PUT", path: "/repos/acme/rocket/pulls/17/auto_merge", body: {} },
          ]);
        }),
      (input) => {
        if (input.stdin !== undefined) {
          writes.push({
            method: input.args[3],
            path: input.args[1] ?? "",
            body: JSON.parse(input.stdin),
          });
          return {};
        }
        return undefined;
      },
    );
  });

  it.effect(
    "submits atomic reviews against the current version with correct diff-side anchors",
    () => {
      let body: unknown;
      return withProvider(
        (provider) =>
          Effect.gen(function* () {
            yield* provider.submitReview({
              ...ref,
              verdict: "request-changes",
              body: "Fix this",
              comments: [
                { path: "a.ts", body: "Removed line", position: { kind: "deleted", oldLine: 3 } },
                { path: "a.ts", body: "Added line", position: { kind: "added", newLine: 4 } },
              ],
            });
            expect(body).toEqual({
              verdict: "request_changes",
              body: "Fix this",
              versionNumber: "3",
              comments: [
                { body: "Removed line", inline: { path: "a.ts", side: "left", startLine: 3 } },
                { body: "Added line", inline: { path: "a.ts", side: "right", startLine: 4 } },
              ],
            });
          }),
        (input) => {
          if (input.args[1]?.endsWith("/reviews")) {
            body = JSON.parse(input.stdin ?? "{}");
            return {};
          }
          return undefined;
        },
      );
    },
  );

  it.effect("replies, resolves, edits comments, removes labels and reviewer requests", () => {
    const writes: string[][] = [];
    return withProvider(
      (provider) =>
        Effect.gen(function* () {
          yield* provider.replyToThread({ ...ref, threadId: "thread", body: "Reply" });
          yield* provider.setThreadResolution({ ...ref, threadId: "thread", resolved: false });
          yield* provider.updateComment!({
            ...ref,
            commentId: "comment",
            kind: "issue-comment",
            body: "Edited",
          });
          yield* provider.setLabels!({ ...ref, labels: ["needs review"], applied: false });
          yield* provider.setReviewerRequest({
            ...ref,
            reviewers: [{ id: "user_other", kind: "user" }],
            requested: false,
          });
          expect(writes.map((args) => [args[1], args[3]])).toEqual([
            ["/repos/acme/rocket/pulls/17/comments", "POST"],
            ["/repos/acme/rocket/pulls/threads/thread", "PATCH"],
            ["/repos/acme/rocket/pulls/comments/comment", "PATCH"],
            ["/repos/acme/rocket/pulls/17/labels/needs%20review", "DELETE"],
            ["/repos/acme/rocket/pulls/17/requested_reviewers", "DELETE"],
          ]);
        }),
      (input) => {
        writes.push([...input.args]);
        return "";
      },
    );
  });
});

it.effect.each([
  {
    action: "reopen",
    state: "closed",
    draft: true,
    autoMerge: undefined,
    method: "PATCH",
    body: { state: "open", draft: true },
  },
  {
    action: "ready",
    state: "open",
    draft: true,
    autoMerge: undefined,
    method: "PATCH",
    body: { draft: false },
  },
  {
    action: "disable-auto-merge",
    state: "open",
    draft: false,
    autoMerge: { mergeMethod: "squash" },
    method: "DELETE",
    body: {},
  },
] as const)("supports the reverse action $action", (testCase) => {
  let write: { method: string | undefined; body: unknown } | undefined;
  return withProvider(
    (provider) =>
      Effect.gen(function* () {
        yield* provider.runAction({ ...ref, action: testCase.action });
        expect(write).toEqual({ method: testCase.method, body: testCase.body });
      }),
    (input) => {
      if (input.stdin !== undefined) {
        write = { method: input.args[3], body: JSON.parse(input.stdin) };
        return {};
      }
      if (input.args[1] === "/repos/acme/rocket/pulls/17")
        return {
          ...pull,
          state: testCase.state,
          draft: testCase.draft,
          ...(testCase.autoMerge ? { autoMerge: testCase.autoMerge } : {}),
        };
      return undefined;
    },
  );
});

it.effect("walks beyond a thousand PRs without rereading previous pages", () => {
  const offsets: number[] = [];
  return withProvider(
    (provider) =>
      Effect.gen(function* () {
        const numbers: number[] = [];
        let cursor: { updatedBefore: string; delivered: number; pageToken: string } | undefined;
        do {
          const result = yield* provider.listChangeRequests({
            ...ref,
            state: "all",
            involvement: "all",
            viewer: "user_viewer",
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          numbers.push(...result.items.map((item) => item.number));
          cursor = result.nextPageToken
            ? {
                updatedBefore: pull.updatedAt,
                delivered: numbers.length,
                pageToken: result.nextPageToken,
              }
            : undefined;
          expect(result.truncated).toBe(cursor !== undefined);
        } while (cursor);
        expect(numbers).toEqual(Array.from({ length: 1101 }, (_, index) => index + 1));
        expect(offsets).toEqual(Array.from({ length: 12 }, (_, index) => index * 100));
      }),
    (input) => {
      if (!input.args[1]?.startsWith("/repos/acme/rocket/pulls?")) return undefined;
      const query = new URL(input.args[1], "https://origin.cursor.com").searchParams;
      const offset = Number(query.get("pageToken") ?? 0);
      const size = Number(query.get("pageSize"));
      offsets.push(offset);
      return {
        pullRequests: Array.from({ length: Math.min(size, 1101 - offset) }, (_, index) => ({
          ...pull,
          number: String(offset + index + 1),
        })),
        ...(offset + size < 1101 ? { nextPageToken: String(offset + size) } : {}),
      };
    },
  );
});

it.effect("reads checks independently for PR status refreshes", () =>
  withProvider(
    (provider) =>
      Effect.gen(function* () {
        const result = yield* provider.getChangeRequestChecks!(ref);
        expect(result).toMatchObject({
          state: "open",
          checks: [{ name: "CI", status: "failure" }],
        });
      }),
    (input) =>
      input.args[1]?.includes("/check-runs")
        ? { checkRuns: [{ name: "CI", status: "completed", conclusion: "failure" }] }
        : undefined,
  ),
);

it.effect("does not call an identity lookup failure an expired login", () =>
  withProvider(
    (provider) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(provider.getViewer({ cwd: ref.cwd, host: ref.host }));
        expect(error.reason).toBe("failed");
        expect(error.detail).toContain("connectivity");
      }),
    (input) => (input.args[0] === "auth" ? { authenticated: true, account: null } : undefined),
  ),
);
