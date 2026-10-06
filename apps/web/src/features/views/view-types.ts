export type ViewKind =
  | "grid"
  | "form"
  | "gallery"
  | "kanban"
  | "calendar"
  | "timeline"
  | "list"
  | "gantt";

export const VIEW_TABS: Array<{ id: ViewKind; label: string }> = [
  { id: "grid", label: "Grid" },
  { id: "form", label: "Form" },
  { id: "gallery", label: "Gallery" },
  { id: "kanban", label: "Kanban" },
  { id: "calendar", label: "Calendar" },
];

export const VIEW_CREATE_OPTIONS: Array<{
  id: ViewKind;
  label: string;
  icon: string;
  color: string;
}> = [
  { id: "grid", label: "Grid", icon: "▦", color: "#2563eb" },
  { id: "calendar", label: "Calendar", icon: "31", color: "#ea580c" },
  { id: "gallery", label: "Gallery", icon: "▣", color: "#7c3aed" },
  { id: "kanban", label: "Kanban", icon: "▥", color: "#16a34a" },
  { id: "timeline", label: "Timeline", icon: "═", color: "#dc2626" },
  { id: "list", label: "List", icon: "☰", color: "#2563eb" },
  { id: "gantt", label: "Gantt", icon: "╤", color: "#0d9488" },
  { id: "form", label: "Form", icon: "▤", color: "#db2777" },
];
