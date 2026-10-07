import { notFound } from "next/navigation";

/**
 * Any URL the store doesn't have. Throwing notFound() here, inside the
 * (store) group, renders (store)/not-found.tsx within the store's layout:
 * the header, the bag and the footer, not a bare page.
 */
export default function Missing(): never {
  notFound();
}
