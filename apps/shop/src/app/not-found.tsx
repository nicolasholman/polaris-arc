import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found", robots: { index: false } };

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-[1440px] flex-col items-start justify-center px-4 sm:px-6 lg:px-10">
      <h1 className="display text-[3.4rem] leading-none sm:text-[5rem]">Nothing here.</h1>
      <p className="mt-5 max-w-md text-[1.05rem] text-muted">That page has moved, or never existed. The collection is still where we left it.</p>
      <Link href="/shop" className="btn btn-ink mt-8">
        Shop the collection
      </Link>
    </div>
  );
}
