import { useState } from "react";
import styles from "./tools-menu.module.css";

const TOOLS = [
  {
    id: "extensions",
    title: "Extensions",
    detail: "Extend the functionality of your base",
    icon: "◈",
  },
  {
    id: "fields",
    title: "Manage fields",
    detail: "Edit fields and inspect dependencies",
    icon: "A",
  },
  {
    id: "templates",
    title: "Record templates",
    detail: "Create records from a template",
    icon: "☰",
  },
  {
    id: "dates",
    title: "Date dependencies",
    detail: "Configure date shifting between dependent records",
    icon: "⇄",
  },
  {
    id: "insights",
    title: "Insights",
    detail: "Understand and improve base health",
    icon: "▮",
  },
] as const;

export function ToolsMenu({
  onManageFields,
}: {
  onManageFields?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        Tools ▾
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                if (tool.id === "fields") onManageFields?.();
                setOpen(false);
              }}
            >
              <span className={styles.icon} aria-hidden>
                {tool.icon}
              </span>
              <span>
                <strong>{tool.title}</strong>
                <span className={styles.detail}>{tool.detail}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
