export type BadgeTone =
  | "muted"
  | "ok"
  | "warning"
  | "danger"
  | "info"
  | "accent";

export interface StatusBadgeProps {
  label: string;
  tone?: BadgeTone;
}

const toneClass: Record<BadgeTone, string> = {
  muted: "badge-muted",
  ok: "badge-ok",
  warning: "badge-warning",
  danger: "badge-danger",
  info: "badge-info",
  accent: "badge-accent",
};

export function StatusBadge({ label, tone = "muted" }: StatusBadgeProps) {
  return <span className={toneClass[tone]}>{label}</span>;
}
