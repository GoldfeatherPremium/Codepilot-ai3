import Link from "next/link";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="mx-auto w-full max-w-sm text-center">
        <h1 className="text-4xl font-bold">404</h1>
        <p className="mt-2 text-base text-faint">Page not found</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-md bg-phosphor px-4 py-2 text-sm font-medium text-black hover:opacity-90"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
