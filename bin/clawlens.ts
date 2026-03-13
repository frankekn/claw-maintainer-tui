function suppressKnownSqliteWarning(): void {
  const originalEmitWarning = process.emitWarning.bind(process);

  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    const type =
      typeof args[0] === "string"
        ? args[0]
        : warning instanceof Error
          ? warning.name
          : undefined;

    if (
      type === "ExperimentalWarning" &&
      /SQLite is an experimental feature and might change at any time/i.test(message)
    ) {
      return;
    }

    originalEmitWarning(warning as Parameters<typeof process.emitWarning>[0], ...(args as []));
  }) as typeof process.emitWarning;
}

suppressKnownSqliteWarning();

const { runCli } = await import("../src/cli.js");

runCli().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
