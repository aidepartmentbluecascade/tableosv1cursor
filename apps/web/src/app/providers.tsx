import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import { queryClient } from "../lib/query-client.ts";
import {
  SearchPalette,
  useSearchPaletteShortcut,
} from "../features/search/SearchPalette.tsx";

/** Must render under RouterProvider (uses useNavigate). */
export function SearchPaletteHost() {
  const [open, setOpen] = useState(false);
  const onOpen = useCallback(() => setOpen(true), []);
  useSearchPaletteShortcut(onOpen);
  return <SearchPalette open={open} onClose={() => setOpen(false)} />;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
