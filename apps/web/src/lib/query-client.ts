import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (
          error instanceof Error &&
          error.name === "ApiProblemError" &&
          "problem" in error &&
          (error as { problem: { status: number } }).problem.status === 401
        ) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});
