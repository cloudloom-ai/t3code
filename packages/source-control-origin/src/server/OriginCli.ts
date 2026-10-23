import { SourceControlProviderKind } from "@t3tools/contracts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const kind = SourceControlProviderKind.make("cursor-origin");
export class OriginCli extends Context.Service<
  OriginCli,
  {
    readonly run: (input: {
      readonly cwd: string;
      readonly operation: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
    }) => Effect.Effect<string, PullRequestProviderError>;
  }
>()("@t3tools/source-control-origin/server/OriginCli") {}

const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  return OriginCli.of({
    run: Effect.fn("OriginCli.run")(function* (input) {
      const output = yield* host.process
        .run({
          cwd: input.cwd,
          operation: `OriginCli.${input.operation}`,
          command: "origin",
          args: input.args,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          maxOutputBytes: 8 * 1024 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestProviderError({
                provider: kind,
                operation: input.operation,
                reason: cause._tag === "VcsProcessSpawnError" ? "missing-tool" : "failed",
                detail:
                  cause._tag === "VcsProcessSpawnError"
                    ? "Install the Origin CLI on the server and run origin auth login."
                    : "The Origin CLI request failed.",
                cause,
              }),
          ),
        );
      if (output.exitCode !== 0) {
        const reason =
          /(?:\b401\b|not_authenticated|unauthenticated|not logged in|session.*expired)/iu.test(
            output.stderr,
          )
            ? "unauthenticated"
            : /(?:\b429\b|resource_exhausted|rate.limit)/iu.test(output.stderr)
              ? "rate-limited"
              : /(?:\b404\b|not_found)/iu.test(output.stderr)
                ? "not-found"
                : "failed";
        return yield* new PullRequestProviderError({
          provider: kind,
          operation: input.operation,
          reason,
          detail:
            reason === "unauthenticated"
              ? "Run origin auth login on the server and rescan Source Control settings."
              : reason === "rate-limited"
                ? "Origin rate limited this request. Try again later."
                : reason === "not-found"
                  ? "Origin could not find this resource."
                  : "Origin refused the request. Check access and the current pull request state.",
          cause: output,
        });
      }
      if (output.stdoutTruncated || output.stdoutInvalidUtf8)
        return yield* new PullRequestProviderError({
          provider: kind,
          operation: input.operation,
          reason: "failed",
          detail: "Origin returned an incomplete response.",
        });
      return output.stdout;
    }),
  });
});
export const layer = Layer.effect(OriginCli, make);

export const request = <A>(
  cli: OriginCli["Service"],
  input: {
    readonly cwd: string;
    readonly operation: string;
    readonly path: string;
    readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly body?: object;
  },
  schema: Schema.Decoder<A>,
) =>
  cli
    .run({
      cwd: input.cwd,
      operation: input.operation,
      args: [
        "api",
        input.path,
        "--method",
        input.method ?? "GET",
        ...(input.body === undefined ? [] : ["--input", "-"]),
      ],
      ...(input.body === undefined ? {} : { stdin: JSON.stringify(input.body) }),
    })
    .pipe(
      Effect.flatMap((stdout) =>
        (stdout.trim()
          ? Schema.decodeEffect(Schema.fromJsonString(schema))(stdout)
          : Schema.decodeEffect(schema)(undefined)
        ).pipe(
          Effect.mapError(
            (cause) =>
              new PullRequestProviderError({
                provider: kind,
                operation: input.operation,
                reason: "failed",
                detail: "Origin returned an invalid response.",
                cause,
              }),
          ),
        ),
      ),
    );
