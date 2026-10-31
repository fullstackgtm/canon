import Link from "next/link";
import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  details?: Array<{
    label: string;
    value: string;
  }>;
  suggestions?: string[];
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  details,
  suggestions,
  action,
}: EmptyStateProps) {
  const hasDetails = details && details.length > 0;
  const hasSuggestions = suggestions && suggestions.length > 0;

  return (
    <div className="border-y border-border/70 bg-muted/25 p-8 text-center sm:p-10">
      <Icon className="mx-auto h-12 w-12 text-muted-foreground opacity-20" />
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mx-auto mt-1 max-w-2xl text-sm text-muted-foreground">
        {description}
      </p>

      {(hasDetails || hasSuggestions) && (
        <div
          className={[
            "mx-auto mt-6 grid gap-3 text-left",
            hasDetails && hasSuggestions
              ? "max-w-4xl md:grid-cols-2"
              : "max-w-2xl",
          ].join(" ")}
        >
          {hasDetails && (
            <div className="border-t border-border/70 pt-4">
              <div className="text-xs font-semibold text-muted-foreground">
                Inherited Inputs
              </div>
              <dl className="mt-3 space-y-2">
                {details.map((detail) => (
                  <div key={detail.label} className="grid gap-0.5">
                    <dt className="text-xs font-medium text-muted-foreground">
                      {detail.label}
                    </dt>
                    <dd className="text-sm text-foreground">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {hasSuggestions && (
            <div className="border-t border-border/70 pt-4">
              <div className="text-xs font-semibold text-muted-foreground">
                Suggested Defaults
              </div>
              <ul className="mt-3 space-y-2">
                {suggestions.map((suggestion) => (
                  <li
                    key={suggestion}
                    className="flex gap-2 text-sm text-foreground"
                  >
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <span>{suggestion}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {action &&
        (action.href ? (
          <Link
            href={action.href}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {action.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {action.label}
          </button>
        ))}
    </div>
  );
}
