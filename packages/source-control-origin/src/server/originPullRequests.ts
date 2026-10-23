import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Schema from "effect/Schema";

const Person = Schema.Struct({
  id: Schema.String,
  email: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  handle: Schema.optional(Schema.String),
});
const Actor = Schema.Struct({
  user: Schema.optional(Person),
  app: Schema.optional(Person),
  serviceAccount: Schema.optional(Person),
});
export const Pull = Schema.Struct({
  number: Schema.String,
  title: Schema.String,
  body: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  author: Schema.optional(Actor),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.optional(Schema.String),
  mergedAt: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  labels: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.optional(Schema.String) })),
  ),
  version: Schema.Struct({ number: Schema.String }),
  stack: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      parentPullRequest: Schema.optional(Schema.Struct({ number: Schema.String })),
    }),
  ),
  autoMerge: Schema.optional(Schema.Struct({ mergeMethod: Schema.optional(Schema.String) })),
});
export const Pulls = Schema.Struct({
  pullRequests: Schema.Array(Pull),
  nextPageToken: Schema.optional(Schema.String),
});
const Comment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  author: Schema.optional(Actor),
  createdAt: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  thread: Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    side: Schema.optional(Schema.String),
    startLine: Schema.Number,
    endLine: Schema.Number,
    resolvedAt: Schema.optional(Schema.String),
    version: Schema.Struct({ headSha: Schema.String }),
  }),
});
export const Comments = Schema.Struct({
  comments: Schema.Array(Comment),
  nextPageToken: Schema.optional(Schema.String),
});
export const Reviews = Schema.Struct({
  reviews: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      body: Schema.String,
      author: Schema.optional(Actor),
      verdict: Schema.String,
      submittedAt: Schema.optional(Schema.String),
      dismissal: Schema.optional(Schema.Unknown),
    }),
  ),
  nextPageToken: Schema.optional(Schema.String),
});
export const Commits = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      commit: Schema.Struct({
        message: Schema.String,
        committer: Schema.Struct({ date: Schema.String }),
      }),
    }),
  ),
  nextPageToken: Schema.optional(Schema.String),
});
export const Files = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      status: Schema.String,
      additions: Schema.Number,
      deletions: Schema.Number,
      patch: Schema.optional(Schema.String),
      previousFilename: Schema.optional(Schema.String),
    }),
  ),
  nextPageToken: Schema.optional(Schema.String),
});
export const Checks = Schema.Struct({
  checkRuns: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.optional(Schema.String),
      detailsUrl: Schema.optional(Schema.String),
      output: Schema.optional(Schema.Struct({ summary: Schema.optional(Schema.String) })),
    }),
  ),
  nextPageToken: Schema.optional(Schema.String),
});
export const Reviewers = Schema.Struct({
  users: Schema.Array(Person),
  groups: Schema.Array(Schema.Struct({ id: Schema.String })),
});
export const Mergeability = Schema.Struct({
  verdict: Schema.String,
  blockers: Schema.Array(
    Schema.Struct({ kind: Schema.optional(Schema.String), message: Schema.String }),
  ),
});

export function actor(value: typeof Actor.Type | undefined): PullRequestActor | null {
  const identity = value?.user ?? value?.app ?? value?.serviceAccount;
  return identity
    ? {
        login: identity.id,
        name: identity.displayName || identity.handle || identity.email || null,
        avatarUrl: null,
        isBot: value?.user === undefined,
      }
    : null;
}
export function summary(pull: typeof Pull.Type, repository: string): ProviderChangeRequest {
  const number = Number(pull.number);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("Invalid Origin pull request number");
  return {
    number,
    title: pull.title,
    url: pull.webUrl || `https://cursor.com/codebase/${repository}/pull/${number}`,
    author: actor(pull.author),
    headBranch: pull.head.ref,
    headRepositoryNameWithOwner: repository,
    baseBranch: pull.base.ref,
    state: pull.merged ? "merged" : pull.state === "closed" ? "closed" : "open",
    isDraft: pull.draft,
    mergeability: "unknown",
    additions: pull.additions,
    deletions: pull.deletions,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt ?? null,
    mergedAt: pull.mergedAt ?? null,
    labels: (pull.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? null })),
    reviewRequestLogins: [],
  };
}
export function check(run: (typeof Checks.Type)["checkRuns"][number]): PullRequestCheck {
  const conclusion = run.conclusion;
  const status =
    run.status !== "completed"
      ? "pending"
      : conclusion === "success"
        ? "success"
        : conclusion === "failure" || conclusion === "timed_out" || conclusion === "stale"
          ? "failure"
          : conclusion === "action_required"
            ? "action-required"
            : conclusion === "skipped"
              ? "skipped"
              : conclusion === "cancelled"
                ? "cancelled"
                : conclusion === "neutral"
                  ? "neutral"
                  : "pending";
  return {
    name: run.name,
    status,
    description: run.output?.summary ?? null,
    url: run.detailsUrl || null,
  };
}
export function permissions(input: {
  canWrite: boolean;
  own: boolean;
  pull: typeof Pull.Type;
}): PullRequestViewerPermissions {
  const { canWrite, own, pull } = input;
  const editable = canWrite || own;
  return {
    actions: pull.merged
      ? []
      : [
          ...(canWrite && !pull.stack?.parentPullRequest && !pull.draft && pull.state === "open"
            ? ["merge" as const]
            : []),
          ...(editable
            ? pull.state === "closed"
              ? ["reopen" as const]
              : ["close" as const, pull.draft ? ("ready" as const) : ("draft" as const)]
            : []),
          ...(canWrite && !pull.stack?.parentPullRequest && pull.state === "open"
            ? [pull.autoMerge ? ("disable-auto-merge" as const) : ("enable-auto-merge" as const)]
            : []),
        ],
    comment: true,
    resolve: editable,
    verdicts: own ? ["comment"] : ["approve", "request-changes", "comment"],
    requestReviewers: editable,
    labels: canWrite,
    editChangeRequest: editable,
  };
}
export function activity(input: {
  comments: ReadonlyArray<typeof Comment.Type>;
  reviews: (typeof Reviews.Type)["reviews"];
  commits: (typeof Commits.Type)["commits"];
  headSha: string;
  truncated: boolean;
}): ProviderChangeRequestActivity {
  const comments: ProviderChangeRequestActivity["comments"][number][] = [];
  const threads = new Map<string, ProviderChangeRequestActivity["reviewThreads"][number]>();
  for (const item of input.comments) {
    const base = {
      id: item.id,
      author: actor(item.author),
      body: item.body,
      createdAt: item.createdAt,
      editedAt: item.updatedAt ?? null,
      url: null,
    };
    if (!item.thread.path) {
      comments.push({ ...base, kind: "issue-comment", path: null, reviewState: null });
      continue;
    }
    const thread = threads.get(item.thread.id) ?? {
      id: item.thread.id,
      path: item.thread.path,
      line: item.thread.endLine || item.thread.startLine || null,
      side: item.thread.side === "left" ? "left" : "right",
      isResolved: !!item.thread.resolvedAt,
      isOutdated: item.thread.version.headSha !== input.headSha,
      comments: [],
    };
    threads.set(item.thread.id, { ...thread, comments: [...thread.comments, base] });
  }
  for (const review of input.reviews)
    if (review.submittedAt)
      comments.push({
        id: review.id,
        kind: "review",
        author: actor(review.author),
        body: review.body,
        createdAt: review.submittedAt,
        url: null,
        path: null,
        reviewState: review.dismissal
          ? "DISMISSED"
          : review.verdict === "approve"
            ? "APPROVED"
            : review.verdict === "request_changes"
              ? "CHANGES_REQUESTED"
              : "COMMENTED",
      });
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    comments,
    commentCount: comments.length,
    commentsTruncated: input.truncated,
    reviewThreadsTruncated: input.truncated,
    reviewThreads: [...threads.values()],
    commits: input.commits.map((commit) => ({
      oid: commit.sha,
      messageHeadline: commit.commit.message.split("\n")[0] ?? "",
      committedDate: commit.commit.committer.date,
    })),
  };
}
