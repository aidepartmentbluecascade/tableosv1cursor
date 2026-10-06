import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api.ts";
import styles from "./automations.module.css";

const SUGGESTED_TRIGGERS = [
  {
    type: "record.matches_conditions",
    label: "When a record matches conditions",
    icon: "◇",
  },
  {
    type: "form.submitted",
    label: "When a form is submitted",
    icon: "☑",
  },
  {
    type: "record.created",
    label: "When a record is created",
    icon: "＋",
  },
  {
    type: "record.updated",
    label: "When a record is updated",
    icon: "✎",
  },
  {
    type: "scheduled",
    label: "At a scheduled time",
    icon: "◷",
  },
  {
    type: "record.enters_view",
    label: "When a record enters a view",
    icon: "◎",
  },
] as const;

function summarizeAutomation(triggerType: string, actionCount: number): string {
  const labels: Record<string, string> = {
    "record.matches_conditions": "When a record matches conditions",
    "form.submitted": "When a form is submitted",
    "record.created": "When a record is created",
    "record.updated": "When a record is updated",
    scheduled: "At a scheduled time",
    "record.enters_view": "When a record enters a view",
  };
  const head = labels[triggerType] ?? "When something happens";
  if (actionCount <= 0) return `${head}`;
  if (actionCount === 1) return `${head}, run 1 action`;
  return `${head}, and ${actionCount} more actions`;
}

export function AutomationsPanel({ baseId }: { baseId: string }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [find, setFind] = useState("");

  const listQuery = useQuery({
    queryKey: ["automations", baseId],
    queryFn: () => api.listAutomations(baseId),
  });

  const createMutation = useMutation({
    mutationFn: (triggerType: string) =>
      api.createAutomation(baseId, {
        name: `Automation ${(listQuery.data?.automations.length ?? 0) + 1}`,
        trigger: { type: triggerType },
        enabled: false,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["automations", baseId] });
      setSelectedId(res.automation.id);
      setCreateOpen(false);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (args: { id: string; enabled: boolean }) =>
      api.patchAutomation(baseId, args.id, { enabled: args.enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["automations", baseId] });
    },
  });

  const automations = (listQuery.data?.automations ?? []).filter((a) =>
    a.name.toLowerCase().includes(find.trim().toLowerCase()),
  );
  const selected =
    automations.find((a) => a.id === selectedId) ?? automations[0] ?? null;
  const remaining = listQuery.data?.limits.remaining ?? 150;

  return (
    <div className={styles.shell}>
      <div className={styles.subHeader}>
        <span className={styles.crumb}>Automations ▸</span>
        {selected ? (
          <>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={selected.enabled}
                onChange={(e) =>
                  toggleMutation.mutate({
                    id: selected.id,
                    enabled: e.target.checked,
                  })
                }
              />
              <span>{selected.enabled ? "ON" : "OFF"}</span>
            </label>
            <strong className={styles.selectedName}>{selected.name}</strong>
          </>
        ) : null}
      </div>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.createWrap}>
            <button
              type="button"
              className={styles.createBtn}
              onClick={() => setCreateOpen((o) => !o)}
            >
              + Create new…
            </button>
            {createOpen ? (
              <div className={styles.createMenu}>
                <button
                  type="button"
                  onClick={() => createMutation.mutate("record.updated")}
                  title="This base can have up to 150 automations"
                >
                  Automation
                  <span className={styles.remaining}>{remaining} remaining</span>
                </button>
                <button type="button" disabled>
                  Section
                  <span className={styles.remaining}>50 remaining</span>
                </button>
                <button type="button" disabled>
                  Browse catalog →
                </button>
              </div>
            ) : null}
          </div>
          <input
            className={styles.find}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Find an automation"
          />
          <ul className={styles.list}>
            {automations.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={
                    selected?.id === a.id
                      ? `${styles.listItem} ${styles.listItemActive}`
                      : styles.listItem
                  }
                  onClick={() => setSelectedId(a.id)}
                >
                  <span className={styles.listIcon}>✎</span>
                  <span>
                    <strong>{a.name}</strong>
                    <span className={styles.listMeta}>
                      <span
                        className={
                          a.enabled ? styles.badgeOn : styles.badgeOff
                        }
                      >
                        {a.enabled ? "ON" : "OFF"}
                      </span>
                      {summarizeAutomation(
                        a.trigger?.type ?? "",
                        a.actions?.length ?? 0,
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className={styles.canvas}>
          <div className={styles.triggerCol}>
            <div className={styles.triggerLabel}>TRIGGER</div>
            {!selected?.trigger?.type ? (
              <>
                <button
                  type="button"
                  className={styles.addTrigger}
                  onClick={() => setCreateOpen(true)}
                >
                  + Add trigger
                </button>
                <p className={styles.suggestedTitle}>
                  Suggested triggers for you:
                </p>
                <ul className={styles.suggested}>
                  {SUGGESTED_TRIGGERS.map((t) => (
                    <li key={t.type}>
                      <button
                        type="button"
                        onClick={() => createMutation.mutate(t.type)}
                      >
                        <span aria-hidden>{t.icon}</span>
                        {t.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className={styles.triggerCard}>
                <strong>
                  {SUGGESTED_TRIGGERS.find(
                    (t) => t.type === selected.trigger.type,
                  )?.label ?? selected.trigger.type}
                </strong>
                <p className={styles.triggerHint}>
                  Connected to Data events in this base. Configure conditions
                  and actions next.
                </p>
                <button
                  type="button"
                  className={styles.panelAction}
                  onClick={() =>
                    createMutation.mutate("record.updated")
                  }
                >
                  + Add another automation
                </button>
              </div>
            )}
            <button type="button" className={styles.seeAll}>
              See all…
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
