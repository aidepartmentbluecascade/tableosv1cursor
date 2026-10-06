import { useMemo } from "react";
import { usePresenceStore } from "../../stores/presence.ts";
import styles from "./presence.module.css";

export function PresenceAvatars() {
  const byConnId = usePresenceStore((s) => s.byConnId);
  const entries = useMemo(() => [...byConnId.values()], [byConnId]);
  if (entries.length === 0) return null;

  return (
    <div className={styles.row} aria-label="Collaborators in this base">
      {entries.map((entry) => {
        const initials =
          entry.user.name
            .split(/\s+/)
            .map((p) => p[0])
            .join("")
            .slice(0, 2)
            .toUpperCase() || "?";
        return (
          <span
            key={entry.connId}
            className={styles.avatar}
            title={entry.user.name}
            style={
              entry.color ? { backgroundColor: entry.color } : undefined
            }
          >
            {initials}
          </span>
        );
      })}
    </div>
  );
}
