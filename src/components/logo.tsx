import { cn } from "@/lib/utils";

interface LogoMarkProps {
  size?: number;
  variant?: "dark" | "primary";
  className?: string;
}

/**
 * CanonCRM mark: an open "C" holding a solid square, the proven record the
 * canon keeps. Same geometry as public/logo.svg and src/app/icon.svg.
 */
export function LogoMark({ size = 28, variant = "dark", className }: LogoMarkProps) {
  const isDark = variant === "dark";
  return (
    <svg
      aria-hidden
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={cn(
        "shrink-0",
        isDark ? "text-sidebar-primary-foreground" : "text-primary-foreground",
        className,
      )}
    >
      <rect width="512" height="512" rx="96" className={isDark ? "fill-sidebar-primary" : "fill-primary"} />
      <path d="M363.25 166.01 A140 140 0 1 0 363.25 345.99" fill="none" stroke="currentColor" strokeWidth="64" />
      <rect x="356" y="224" width="64" height="64" fill="currentColor" />
    </svg>
  );
}

interface LogoProps {
  size?: number;
  variant?: "dark" | "primary";
  showWordmark?: boolean;
  className?: string;
}

export function Logo({ size = 28, variant = "dark", showWordmark = true, className }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark size={size} variant={variant} />
      {showWordmark && (
        <span className="record-name text-[15px]">
          CanonCRM
        </span>
      )}
    </span>
  );
}
