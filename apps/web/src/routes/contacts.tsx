import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import styles from "./contacts.module.css";

export function ContactsPage({ workspaceId }: { workspaceId: string }) {
  const contactsQuery = useQuery({
    queryKey: ["contacts", workspaceId],
    queryFn: () => api.workspaceContacts(workspaceId),
  });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.back}>
          ← Home
        </Link>
        <h1>Contacts</h1>
      </header>
      {contactsQuery.isLoading ? (
        <p className={styles.muted}>Loading contacts…</p>
      ) : contactsQuery.isError ? (
        <p className={styles.muted}>Could not load contacts.</p>
      ) : (
        <ul className={styles.list}>
          {(contactsQuery.data?.contacts ?? []).map((c) => (
            <li key={c.id} className={styles.row}>
              <strong>{c.name}</strong>
              {c.email ? (
                <span className={styles.muted}>{c.email}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
