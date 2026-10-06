import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiProblemError } from "../../lib/api.ts";

export const authQueryKey = ["auth", "me"] as const;

export function useMe(enabled = true) {
  return useQuery({
    queryKey: authQueryKey,
    queryFn: () => api.me(),
    enabled,
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (body: { email: string; password: string }) => api.login(body),
    onSuccess: (user) => {
      queryClient.setQueryData(authQueryKey, user);
      void navigate({ to: "/" });
    },
  });
}

export function useSignup() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: (body: { email: string; password: string; name: string }) =>
      api.signup(body),
    onSuccess: (user) => {
      queryClient.setQueryData(authQueryKey, user);
      void navigate({ to: "/" });
    },
  });
}

export function authErrorMessage(error: unknown): string {
  if (error instanceof ApiProblemError) {
    return error.problem.detail ?? error.problem.title;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong";
}
