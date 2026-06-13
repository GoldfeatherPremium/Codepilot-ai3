"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-center">
            <h2 className="text-lg font-semibold">Critical error</h2>
            <p className="mt-2 text-sm">
              {error.message || "The application encountered a critical error."}
            </p>
            <button
              onClick={() => reset()}
              className="mt-6 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white"
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
