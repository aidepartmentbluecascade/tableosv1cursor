import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@tabula/ui";
import { api } from "../../lib/api.ts";
import styles from "./notifications.module.css";

const POLL_MS = 30_000;

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const notificationsQuery = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.notifications(),
    refetchInterval: POLL_MS,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const unread = notificationsQuery.data?.unreadCount ?? 0;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.bell}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        🔔
        {unread > 0 ? <span className={styles.badge}>{unread}</span> : null}
      </button>
      {open ? (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>Notifications</div>
          <ul className={styles.list}>
            {(notificationsQuery.data?.notifications ?? []).map((n) => (
              <li
                key={n.id}
                className={n.readAt ? styles.read : styles.unread}
              >
                <strong>{n.title}</strong>
                <p>{n.body}</p>
                {!n.readAt ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => markRead.mutate(n.id)}
                  >
                    Mark read
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
