import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import { layer, processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import * as OriginCli from "./OriginCli.ts";

it.effect.each([
  ["unauthenticated: session expired", "unauthenticated"],
  ["HTTP 429: rate limit", "rate-limited"],
  ["HTTP 404: not_found", "not-found"],
  ["HTTP 403: permission_denied", "failed"],
] as const)("reports %s as %s without exposing CLI diagnostics", ([stderr, reason]) =>
  Effect.gen(function* () {
    const cli = yield* OriginCli.OriginCli;
    const error = yield* Effect.flip(
      cli.run({
        cwd: "/repo",
        operation: "getPull",
        args: ["api", "/repos/acme/rocket/pulls/17"],
      }),
    );
    expect(error.reason).toBe(reason);
    expect(error.detail).not.toContain("private-diagnostic");
    expect(error.cause).toMatchObject({ stderr: `${stderr} private-diagnostic` });
  }).pipe(
    Effect.provide(
      OriginCli.layer.pipe(
        Layer.provide(
          layer({
            process: {
              run: () =>
                Effect.succeed(
                  processOutput("", {
                    exitCode: ChildProcessSpawner.ExitCode(1),
                    stderr: `${stderr} private-diagnostic`,
                  }),
                ),
            },
          }),
        ),
      ),
    ),
  ),
);

it.effect("reports a missing CLI as missing-tool", () =>
  Effect.gen(function* () {
    const cli = yield* OriginCli.OriginCli;
    const error = yield* Effect.flip(
      cli.run({ cwd: "/repo", operation: "getViewer", args: ["auth", "status"] }),
    );
    expect(error.reason).toBe("missing-tool");
  }).pipe(
    Effect.provide(
      OriginCli.layer.pipe(
        Layer.provide(
          layer({
            process: {
              run: () =>
                Effect.fail(
                  new VcsProcessSpawnError({
                    cwd: "/repo",
                    operation: "getViewer",
                    command: "origin",
                    cause: new Error("ENOENT"),
                  }),
                ),
            },
          }),
        ),
      ),
    ),
  ),
);

it.effect("refuses truncated JSON and returns a typed error for malformed responses", () =>
  Effect.gen(function* () {
    const cli = yield* OriginCli.OriginCli;
    const error = yield* Effect.flip(
      OriginCli.request(
        cli,
        { cwd: "/repo", operation: "getPull", path: "/repos/acme/rocket/pulls/17" },
        Schema.Struct({ number: Schema.String }),
      ),
    );
    expect(error.reason).toBe("failed");
    expect(error.detail).toContain("incomplete");
  }).pipe(
    Effect.provide(
      OriginCli.layer.pipe(
        Layer.provide(
          layer({
            process: {
              run: () =>
                Effect.succeed({ ...processOutput('{"number":"17"}'), stdoutTruncated: true }),
            },
          }),
        ),
      ),
    ),
  ),
);
