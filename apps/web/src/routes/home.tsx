import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Input } from "@tabula/ui";
import { api } from "../lib/api.ts";
import { useMe } from "../features/auth/use-auth.ts";
import styles from "./home.module.css";

function WorkspaceBases({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const queryClient = useQueryClient();
  const [newBaseName, setNewBaseName] = useState("");

  const basesQuery = useQuery({
    queryKey: ["workspaces", workspaceId, "bases"],
    queryFn: () => api.workspaceBases(workspaceId),
  });

  const createBase = useMutation({
    mutationFn: (name: string) => api.createBase(workspaceId, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workspaces", workspaceId, "bases"],
      });
      setNewBaseName("");
    },
  });

  return (
    <div className={styles.workspaceBlock}>
      <div className={styles.workspaceName}>{workspaceName}</div>
      {basesQuery.isLoading ? (
        <p className={styles.muted}>Loading bases…</p>
      ) : basesQuery.isError ? (
        <p className={styles.muted}>Could not load bases</p>
      ) : (
        <ul className={styles.baseList}>
          {(basesQuery.data?.bases ?? []).map((base) => (
            <li key={base.id} className={styles.baseRow}>
              <Link to="/bases/$baseId" params={{ baseId: base.id }}>
                {base.name}
              </Link>
            </li>
          ))}
          {(basesQuery.data?.bases ?? []).length === 0 ? (
            <li className={styles.muted}>No bases yet</li>
          ) : null}
        </ul>
      )}
      <form
        className={styles.createRow}
        onSubmit={(e) => {
          e.preventDefault();
          const name = newBaseName.trim();
          if (name) createBase.mutate(name);
        }}
      >
        <Input
          placeholder="New base name"
          value={newBaseName}
          onChange={(e) => setNewBaseName(e.target.value)}
          aria-label={`New base in ${workspaceName}`}
        />
        <Button type="submit" disabled={createBase.isPending || !newBaseName.trim()}>
          Create base
        </Button>
      </form>
    </div>
  );
}

export function HomePage() {
  const me = useMe();
  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.workspaces(),
    enabled: me.isSuccess,
  });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logo}>Tabula</span>
        <div className={styles.headerActions}>
          {(workspacesQuery.data?.workspaces ?? [])[0] ? (
            <Link
              to="/contacts"
              search={{
                workspaceId: workspacesQuery.data!.workspaces[0]!.id,
              }}
              className={styles.contactsLink}
            >
              Contacts
            </Link>
          ) : null}
          {me.data ? (
            <span className={styles.muted}>{me.data.name || me.data.email}</span>
          ) : null}
        </div>
      </header>
      <main className={styles.main}>
        <section className={styles.section}>
          <h1 className={styles.sectionTitle}>Your workspaces</h1>
          {workspacesQuery.isLoading ? (
            <p className={styles.muted}>Loading…</p>
          ) : workspacesQuery.isError ? (
            <p className={styles.muted}>Could not load workspaces</p>
          ) : (
            (workspacesQuery.data?.workspaces ?? []).map((w) => (
              <WorkspaceBases key={w.id} workspaceId={w.id} workspaceName={w.name} />
            ))
          )}
          {(workspacesQuery.data?.workspaces ?? []).length === 0 &&
          !workspacesQuery.isLoading ? (
            <p className={styles.muted}>No workspaces yet.</p>
          ) : null}
        </section>
      </main>
    </div>
  );
}
