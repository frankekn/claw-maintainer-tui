export type ConcurrencyErrorMode = "continue" | "stop";

export async function runTasksWithConcurrency<T>(params: {
  tasks: Array<() => Promise<T>>;
  limit: number;
  errorMode?: ConcurrencyErrorMode;
  onTaskError?: (error: unknown, index: number) => void;
}): Promise<{ results: T[]; firstError: unknown; hasError: boolean }> {
  const { tasks, onTaskError } = params;
  const errorMode = params.errorMode ?? "continue";
  if (tasks.length === 0) {
    return { results: [], firstError: undefined, hasError: false };
  }

  const resolvedLimit = Math.max(1, Math.min(params.limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let nextIndex = 0;
  let firstError: unknown = undefined;
  let hasError = false;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (errorMode === "stop" && hasError) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]!();
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
        onTaskError?.(error, index);
        if (errorMode === "stop") {
          return;
        }
      }
    }
  });

  await Promise.allSettled(workers);
  return { results, firstError, hasError };
}
