interface LoadingStateProps {
  count?: number;
  height?: string;
  className?: string;
}

export function LoadingRows({
  count = 3,
  height = "h-16",
  className,
}: LoadingStateProps) {
  return (
    <div className={`space-y-3 ${className ?? ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={`${height} animate-pulse bg-muted/70`}
        />
      ))}
    </div>
  );
}

export function LoadingCards({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4 ${className ?? ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse bg-muted/70"
        />
      ))}
    </div>
  );
}
