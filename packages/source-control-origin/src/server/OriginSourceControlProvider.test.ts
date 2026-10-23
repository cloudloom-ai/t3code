import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { layer, processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Origin from "./OriginSourceControlProvider.ts";

const pull = {
  number: "17",
  title: "Launch",
  state: "open",
  merged: false,
  draft: false,
  head: { ref: "feature", sha: "abc" },
  base: { ref: "main" },
  updatedAt: "2026-10-22T00:00:00Z",
};
const runWith = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | import("@t3tools/source-control-core/server/SourceControlHost").SourceControlHost
    | FileSystem.FileSystem
  >,
  process: Parameters<typeof layer>[0],
) =>
  effect.pipe(
    Effect.provide(
      Layer.merge(
        layer(process),
        FileSystem.layerNoop({ readFileString: () => Effect.succeed("Description") }),
      ),
    ),
  );

describe("Cursor Origin", () => {
  it("discovers authenticated and signed-out CLI sessions without exposing credentials", () => {
    expect(Origin.discovery.parseAuth(processOutput('{"authenticated":true}')).status).toBe(
      "authenticated",
    );
    expect(Origin.discovery.parseAuth(processOutput('{"authenticated":false}')).status).toBe(
      "unauthenticated",
    );
    expect(Origin.discovery.parseAuth(processOutput("offline")).status).toBe("unknown");
  });

  it.effect("paginates, filters closed vs merged, and normalizes string PR numbers", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const result = yield* runWith(
        Effect.gen(function* () {
          const provider = yield* Origin.make;
          return yield* provider.listChangeRequests({
            cwd: "/repo",
            headSelector: "feature",
            state: "closed",
          });
        }),
        {
          git: {
            resolvePrimaryRemoteName: () => Effect.succeed("origin"),
            readConfigValue: () => Effect.succeed("https://origin.cursor.com/git/acme/rocket.git"),
          },
          process: {
            run: (input) => {
              calls.push([...input.args]);
              return Effect.succeed(
                processOutput(
                  JSON.stringify(
                    calls.length === 1
                      ? {
                          pullRequests: [{ ...pull, state: "closed", merged: true }],
                          nextPageToken: "next",
                        }
                      : { pullRequests: [{ ...pull, state: "closed" }] },
                  ),
                ),
              );
            },
          },
        },
      );
      expect(result).toMatchObject([
        {
          number: 17,
          state: "closed",
          headRepositoryNameWithOwner: "acme/rocket",
          url: "https://cursor.com/codebase/acme/rocket/pull/17",
        },
      ]);
      expect(calls[1]?.[1]).toContain("pageToken=next");
      expect(calls[0]?.[1]).toContain("/repos/acme/rocket/pulls?");
    }),
  );

  it.effect("creates a PR using a JSON body over stdin", () =>
    Effect.gen(function* () {
      const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
      yield* runWith(
        Effect.gen(function* () {
          const provider = yield* Origin.make;
          yield* provider.createChangeRequest({
            cwd: "/repo",
            context: {
              provider: {
                kind: provider.kind,
                name: "Cursor Origin",
                baseUrl: "https://origin.cursor.com",
              },
              remoteName: "origin",
              remoteUrl: "https://origin.cursor.com/acme/rocket.git",
            },
            headSelector: "feature",
            baseRefName: "main",
            title: "Launch",
            bodyFile: "/body",
          });
        }),
        {
          process: {
            run: (input) => {
              calls.push(input);
              return Effect.succeed(processOutput(JSON.stringify(pull)));
            },
          },
        },
      );
      expect(calls[0]?.args).toEqual([
        "api",
        "/repos/acme/rocket/pulls",
        "--method",
        "POST",
        "--input",
        "-",
      ]);
      expect(JSON.parse(calls[0]?.stdin ?? "{}")).toEqual({
        title: "Launch",
        body: "Description",
        head: "feature",
        base: "main",
      });
    }),
  );

  it.effect("checks out a linked PR with the selected remote and force option", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      yield* runWith(
        Effect.gen(function* () {
          const provider = yield* Origin.make;
          yield* provider.checkoutChangeRequest({
            cwd: "/repo",
            reference: "https://cursor.com/codebase/acme/rocket/pull/17",
            force: true,
            context: {
              provider: {
                kind: provider.kind,
                name: "Cursor Origin",
                baseUrl: "https://origin.cursor.com",
              },
              remoteName: "upstream",
              remoteUrl: "https://origin.cursor.com/acme/rocket.git",
            },
          });
        }),
        {
          process: {
            run: (input) => {
              calls.push([...input.args]);
              return Effect.succeed(processOutput(JSON.stringify(pull)));
            },
          },
        },
      );
      expect(calls[1]).toEqual([
        "pr",
        "checkout",
        "17",
        "--repo",
        "acme/rocket",
        "--remote",
        "upstream",
        "--force",
      ]);
    }),
  );

  it.effect("rejects malformed API numbers through the typed error channel", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runWith(
          Effect.gen(function* () {
            const provider = yield* Origin.make;
            return yield* provider.getChangeRequest({
              cwd: "/repo",
              reference: "https://cursor.com/codebase/acme/rocket/pull/17",
            });
          }),
          {
            process: {
              run: () =>
                Effect.succeed(
                  processOutput(JSON.stringify({ ...pull, number: "9007199254740992" })),
                ),
            },
          },
        ),
      );
      expect(error.detail).toContain("invalid pull request number");
    }),
  );
  it.effect("uses an Origin remote when checking out a link from another repository", () =>
    Effect.gen(function* () {
      const remotes: string[] = [];
      const calls: string[][] = [];
      yield* runWith(
        Effect.gen(function* () {
          const provider = yield* Origin.make;
          yield* provider.checkoutChangeRequest({
            cwd: "/repo",
            reference: "https://cursor.com/codebase/acme/rocket/pull/17",
            context: {
              provider: {
                kind: provider.kind,
                name: "Cursor Origin",
                baseUrl: "https://origin.cursor.com",
              },
              remoteName: "origin",
              remoteUrl: "https://origin.cursor.com/acme/other.git",
            },
          });
        }),
        {
          git: {
            ensureRemote: (input) => {
              remotes.push(input.url);
              return Effect.succeed("cursor-origin");
            },
          },
          process: {
            run: (input) => {
              calls.push([...input.args]);
              return Effect.succeed(processOutput(JSON.stringify(pull)));
            },
          },
        },
      );
      expect(remotes).toEqual(["https://origin.cursor.com/acme/rocket.git"]);
      expect(calls[1]?.slice(-2)).toEqual(["--remote", "cursor-origin"]);
    }),
  );

  it.effect("rejects cross-repository PR creation before calling the CLI", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runWith(
          Effect.gen(function* () {
            const provider = yield* Origin.make;
            yield* provider.createChangeRequest({
              cwd: "/repo",
              headSelector: "feature",
              baseRefName: "main",
              title: "Launch",
              bodyFile: "/body",
              source: { refName: "feature", repository: "acme/other" },
              context: {
                provider: {
                  kind: provider.kind,
                  name: "Cursor Origin",
                  baseUrl: "https://origin.cursor.com",
                },
                remoteName: "origin",
                remoteUrl: "https://origin.cursor.com/acme/rocket.git",
              },
            });
          }),
          {},
        ),
      );
      expect(error.detail).toContain("same repository");
    }),
  );
});
