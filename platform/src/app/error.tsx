"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="mx-auto w-full max-w-sm text-center">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="mt-2 text-sm text-faint">
          {error.message || "An unexpected error occurred."}
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => reset()}
            className="flex-1 rounded-md bg-phosphor px-4 py-2 text-sm font-medium text-black hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="flex-1 rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-raised"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
