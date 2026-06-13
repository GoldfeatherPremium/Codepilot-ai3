import { Button } from "./button";
import Link from "next/link";

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line py-20 text-center animate-slideUp">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-line bg-raised text-muted">
        {icon}
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      {actionLabel && actionHref && (
        <Link href={actionHref} className="mt-5">
          <Button size="sm">{actionLabel}</Button>
        </Link>
      )}
    </div>
  );
}
