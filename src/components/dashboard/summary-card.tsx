import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";

interface SummaryCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  change?: {
    value: number;
    label: string;
  };
}

export function SummaryCard({ label, value, icon: Icon, change }: SummaryCardProps) {
  return (
    <div className="border-b border-border/70 py-5">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-muted-foreground">{label}</span>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {change && (
        <div className="mt-1 flex items-center gap-1 text-xs">
          {change.value >= 0 ? (
            <ArrowUpRight className="h-3 w-3 text-primary" />
          ) : (
            <ArrowDownRight className="h-3 w-3 text-destructive" />
          )}
          <span className={change.value >= 0 ? "text-primary" : "text-destructive"}>
            {change.value >= 0 ? "+" : ""}
            {change.value}%
          </span>
          <span className="text-muted-foreground">{change.label}</span>
        </div>
      )}
    </div>
  );
}
