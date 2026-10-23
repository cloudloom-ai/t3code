import {
  SourceControlProviderKind,
  SourceControlProviderError,
  type ChangeRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  providerAuth,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const kind = SourceControlProviderKind.make("cursor-origin");
const Auth = Schema.Struct({ authenticated: Schema.Boolean });
const decodeAuth = Schema.decodeUnknownResult(Schema.fromJsonString(Auth));

export const discovery: SourceControlCliDiscoverySpec = {
  type: "cli",
  kind,
  label: "Cursor Origin",
  executable: "origin",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "authenticated"],
  installHint:
    "Install the Origin CLI from https://cursor.com/docs/api/origin and run origin auth login.",
  parseAuth: ({ stdout, exitCode }) => {
    const decoded = decodeAuth(stdout.trim());
    return providerAuth({
      host: "origin.cursor.com",
      status: Result.isSuccess(decoded)
        ? decoded.success.authenticated && exitCode === 0
          ? "authenticated"
          : "unauthenticated"
        : "unknown",
    });
  },
};

const Pull = Schema.Struct({
  number: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  webUrl: Schema.optional(Schema.String),
  updatedAt: Schema.String,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const Pulls = Schema.Struct({
  pullRequests: Schema.Array(Pull),
  nextPageToken: Schema.optional(Schema.String),
});
const Repository = Schema.Struct({ defaultBranch: Schema.String });

function repositoryPath(input: string): string | null {
  let path = input.trim();
  if (path.includes("://")) {
    try {
      const url = new URL(path);
      if (url.protocol !== "https:" || url.hostname !== "origin.cursor.com") return null;
      path = url.pathname.replace(/^\/(?:git\/)?/u, "");
    } catch {
      return null;
    }
  }
  path = path.replace(/\.git\/?$/u, "").replace(/\/$/u, "");
  return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/u.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
    ? path
    : null;
}

function normalizePull(pull: typeof Pull.Type, repository: string): ChangeRequest {
  const number = Number(pull.number);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid Origin PR number");
  return {
    provider: kind,
    number,
    title: pull.title,
    url: pull.webUrl || `https://cursor.com/codebase/${repository}/pull/${number}`,
    baseRefName: pull.base.ref,
    headRefName: pull.head.ref,
    headSha: pull.head.sha,
    state: pull.merged ? "merged" : pull.state,
    isDraft: pull.draft,
    closedAt: pull.closedAt ?? null,
    mergedAt: pull.mergedAt ?? null,
    updatedAt: DateTime.make(pull.updatedAt),
    // Origin currently requires both refs to resolve inside the same repository.
    isCrossRepository: false,
    headRepositoryNameWithOwner: repository,
    headRepositoryOwnerLogin: repository.split("/")[0] ?? null,
  };
}

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const run = (cwd: string, operation: string, args: ReadonlyArray<string>, stdin?: string) =>
    host.process
      .run({
        cwd,
        operation: `OriginSourceControlProvider.${operation}`,
        command: "origin",
        args,
        ...(stdin === undefined ? {} : { stdin }),
        timeoutMs: 30_000,
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: kind,
              operation,
              cwd,
              detail: "Origin CLI command failed. Check origin auth status on the server.",
              cause,
            }),
        ),
      );
  const api = <A>(
    cwd: string,
    operation: string,
    path: string,
    schema: Schema.Decoder<A>,
    body?: object,
  ) =>
    run(
      cwd,
      operation,
      ["api", path, ...(body === undefined ? [] : ["--method", "POST", "--input", "-"])],
      body === undefined ? undefined : JSON.stringify(body),
    ).pipe(
      Effect.flatMap((output) => Schema.decodeEffect(Schema.fromJsonString(schema))(output.stdout)),
      Effect.mapError((cause) =>
        isSourceControlProviderError(cause)
          ? cause
          : new SourceControlProviderError({
              provider: kind,
              operation,
              cwd,
              detail: "Origin returned an invalid response.",
              cause,
            }),
      ),
    );
  const target = Effect.fn("OriginSourceControlProvider.target")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    const remote =
      input.repository ??
      input.context?.remoteUrl ??
      (yield* host.git.resolvePrimaryRemoteName(input.cwd).pipe(
        Effect.flatMap((name) => host.git.readConfigValue(input.cwd, `remote.${name}.url`)),
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: kind,
              operation: "resolveRepository",
              cwd: input.cwd,
              detail: "Could not read the Origin remote.",
              cause,
            }),
        ),
      ));
    const repository = remote ? repositoryPath(remote) : null;
    if (!repository)
      return yield* new SourceControlProviderError({
        provider: kind,
        operation: "resolveRepository",
        cwd: input.cwd,
        detail: "An Origin repository must be owner/repo or an origin.cursor.com HTTPS remote.",
      });
    return repository;
  });
  const getPull = Effect.fn("OriginSourceControlProvider.getPull")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const link = parseChangeRequestUrl(input.reference);
    const repository = link?.host === "origin.cursor.com" ? link.repository : yield* target(input);
    const number =
      link?.host === "origin.cursor.com" ? link.number : Number(input.reference.replace(/^#/u, ""));
    if (!Number.isSafeInteger(number) || number < 1)
      return yield* new SourceControlProviderError({
        provider: kind,
        operation: "getChangeRequest",
        cwd: input.cwd,
        detail:
          "An Origin pull request must be a positive number or a Cursor Origin pull request URL.",
      });
    const pull = yield* api(
      input.cwd,
      "getChangeRequest",
      `/repos/${repository}/pulls/${number}`,
      Pull,
    );
    return yield* Effect.try({
      try: () => normalizePull(pull, repository),
      catch: (cause) =>
        new SourceControlProviderError({
          provider: kind,
          operation: "getChangeRequest",
          cwd: input.cwd,
          detail: "Origin returned an invalid pull request number.",
          cause,
        }),
    });
  });
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    repositoryNameFromRemoteUrl: repositoryPath,
    getChangeRequest: getPull,
    listChangeRequests: Effect.fn("OriginSourceControlProvider.listChangeRequests")(
      function* (input) {
        const repository = yield* target(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        if (
          (source?.repository && source.repository !== repository) ||
          (source?.owner && source.owner !== repository.split("/")[0])
        )
          return [];
        const branch = SourceControlProvider.sourceBranch(input);
        const limit = input.limit ?? 20;
        if (limit <= 0) return [];
        const items: ChangeRequest[] = [];
        const seen = new Set<string>();
        let pageToken = "";
        do {
          const query = new URLSearchParams({
            head: branch,
            state: input.state,
            pageSize: String(Math.min(100, limit - items.length)),
          });
          if (pageToken) query.set("pageToken", pageToken);
          const page = yield* api(
            input.cwd,
            "listChangeRequests",
            `/repos/${repository}/pulls?${query}`,
            Pulls,
          );
          for (const pull of page.pullRequests) {
            if (
              pull.head.ref !== branch ||
              (input.state !== "all" && (pull.merged ? "merged" : pull.state) !== input.state)
            )
              continue;
            const normalized = yield* Effect.try({
              try: () => normalizePull(pull, repository),
              catch: (cause) =>
                new SourceControlProviderError({
                  provider: kind,
                  operation: "listChangeRequests",
                  cwd: input.cwd,
                  detail: "Origin returned an invalid pull request number.",
                  cause,
                }),
            });
            if (!items.some((item) => item.number === normalized.number)) items.push(normalized);
            if (items.length >= limit) break;
          }
          pageToken = page.nextPageToken ?? "";
          if (seen.has(pageToken)) break;
          seen.add(pageToken);
        } while (pageToken && items.length < limit);
        return items;
      },
    ),
    createChangeRequest: Effect.fn("OriginSourceControlProvider.createChangeRequest")(
      function* (input) {
        const repository = yield* target(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        if (
          (source?.repository && source.repository !== repository) ||
          (input.target?.repository && input.target.repository !== repository) ||
          (source?.owner && source.owner !== repository.split("/")[0])
        )
          return yield* new SourceControlProviderError({
            provider: kind,
            operation: "createChangeRequest",
            cwd: input.cwd,
            detail: "Origin requires pull request branches in the same repository.",
          });
        const body = yield* fs.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: kind,
                operation: "createChangeRequest",
                cwd: input.cwd,
                detail: "Could not read the pull request description.",
                cause,
              }),
          ),
        );
        yield* api(input.cwd, "createChangeRequest", `/repos/${repository}/pulls`, Pull, {
          title: input.title,
          body,
          head: SourceControlProvider.sourceBranch(input),
          base: input.target?.refName ?? input.baseRefName,
        });
      },
    ),
    getRepositoryCloneUrls: Effect.fn("OriginSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const repository = yield* target(input);
        yield* api(input.cwd, "getRepositoryCloneUrls", `/repos/${repository}`, Repository);
        // Origin supports HTTPS cloning only. Keep the shared transport fallback on HTTPS.
        return {
          nameWithOwner: repository,
          url: `https://origin.cursor.com/${repository}.git`,
          sshUrl: `https://origin.cursor.com/${repository}.git`,
        };
      },
    ),
    createRepository: (input) =>
      Effect.fail(
        new SourceControlProviderError({
          provider: kind,
          operation: "createRepository",
          cwd: input.cwd,
          detail:
            "Create the repository in Cursor Origin, then clone it in T3. Origin does not expose visibility selection during repository creation.",
        }),
      ),
    getDefaultBranch: Effect.fn("OriginSourceControlProvider.getDefaultBranch")(function* (input) {
      const repository = yield* target(input);
      return (yield* api(input.cwd, "getDefaultBranch", `/repos/${repository}`, Repository))
        .defaultBranch;
    }),
    checkoutChangeRequest: Effect.fn("OriginSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const pull = yield* getPull(input);
        const repository = pull.headRepositoryNameWithOwner!;
        const remoteName =
          input.context && repositoryPath(input.context.remoteUrl) === repository
            ? input.context.remoteName
            : yield* host.git
                .ensureRemote({
                  cwd: input.cwd,
                  preferredName: "cursor-origin",
                  url: `https://origin.cursor.com/${repository}.git`,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new SourceControlProviderError({
                        provider: kind,
                        operation: "checkoutChangeRequest",
                        cwd: input.cwd,
                        detail: "Could not configure the Origin checkout remote.",
                        cause,
                      }),
                  ),
                );
        yield* run(input.cwd, "checkoutChangeRequest", [
          "pr",
          "checkout",
          String(pull.number),
          "--repo",
          repository,
          "--remote",
          remoteName,
          ...(input.force ? ["--force"] : []),
        ]);
      },
    ),
  });
});
