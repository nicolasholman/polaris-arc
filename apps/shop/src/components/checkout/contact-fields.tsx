"use client";

import { useId } from "react";

export interface BuyerForm {
  email: string;
  phone: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
  country: string;
}

/** Filled in for the demo, so a recording goes straight to payment. Every field stays editable. */
export const DEMO_BUYER: BuyerForm = {
  email: "lena.hartmann@example.com",
  phone: "",
  name: "Lena Hartmann",
  line1: "Torstraße 118",
  line2: "",
  city: "Berlin",
  postalCode: "10119",
  country: "Germany",
};

const COUNTRIES = ["Argentina", "Australia", "Canada", "France", "Germany", "India", "Japan", "Netherlands", "Philippines", "Singapore", "United Kingdom", "United States"];

export function validateBuyer(b: BuyerForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(b.email.trim())) errors["contact.email"] = "Enter an email address like name@example.com.";
  if (!b.name.trim()) errors["address.name"] = "Enter your name.";
  if (!b.line1.trim()) errors["address.line1"] = "Enter a street address.";
  if (!b.city.trim()) errors["address.city"] = "Enter a city.";
  if (!b.postalCode.trim()) errors["address.postalCode"] = "Enter a postcode.";
  if (!b.country.trim()) errors["address.country"] = "Choose a country.";
  return errors;
}

function Field({
  label,
  name,
  value,
  error,
  onChange,
  onBlur,
  autoComplete,
  type = "text",
  optional = false,
  className = "",
  inputMode,
}: {
  label: string;
  name: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  autoComplete: string;
  type?: string;
  optional?: boolean;
  className?: string;
  inputMode?: "email" | "tel" | "text" | "numeric";
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {optional ? <span className="font-normal text-faint"> (optional)</span> : null}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        inputMode={inputMode}
        className="field"
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        required={!optional}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[0.86rem] text-alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Human names for the fields, for an error that says which ones need another look. */
export const FIELD_NAMES: Record<string, string> = {
  "contact.email": "email",
  "contact.phone": "phone number",
  "address.name": "full name",
  "address.line1": "street address",
  "address.line2": "flat or floor",
  "address.city": "city",
  "address.postalCode": "postcode",
  "address.country": "country",
};

/**
 * The buyer's details as one card, when they're already complete (the demo
 * fills them in): the payment choice then sits in the first screen instead
 * of under eight filled inputs. Edit opens the fields.
 */
export function ContactSummary({ value, onEdit }: { value: BuyerForm; onEdit: () => void }) {
  return (
    <section aria-labelledby="contact-title" className="rounded-2xl bg-paper px-5 py-4 shadow-[inset_0_0_0_1px_var(--color-hair)] sm:px-6">
      <div className="flex items-center justify-between gap-4">
        <h2 id="contact-title" className="text-[0.8rem] font-semibold uppercase tracking-[0.1em] text-muted">
          Contact and delivery
        </h2>
        <button type="button" onClick={onEdit} className="link -my-2 inline-flex min-h-11 items-center px-2 -mr-2 text-[0.92rem]">
          Edit
        </button>
      </div>
      <p className="mt-1 text-[0.98rem] leading-relaxed text-ink">
        <span className="font-medium">{value.name}</span> · {value.email}
        {value.phone ? ` · ${value.phone}` : ""}
      </p>
      <p className="text-[0.95rem] leading-relaxed text-ink-2">
        {value.line1}
        {value.line2 ? `, ${value.line2}` : ""}, {value.postalCode} {value.city}, {value.country}
      </p>
    </section>
  );
}

export function ContactFields({
  value,
  errors,
  onChange,
  onBlur,
}: {
  value: BuyerForm;
  errors: Record<string, string>;
  onChange: (next: BuyerForm) => void;
  onBlur: () => void;
}) {
  const set = (key: keyof BuyerForm) => (v: string) => onChange({ ...value, [key]: v });
  const countryId = useId();
  return (
    <>
      <section aria-labelledby="contact-title">
        <h2 id="contact-title" className="display text-[1.9rem]">
          Contact
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Email" name="email" type="email" inputMode="email" autoComplete="email" value={value.email} error={errors["contact.email"]} onChange={set("email")} onBlur={onBlur} />
          <Field label="Phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" optional value={value.phone} error={errors["contact.phone"]} onChange={set("phone")} onBlur={onBlur} />
        </div>
      </section>

      <section aria-labelledby="delivery-title" className="mt-12">
        <h2 id="delivery-title" className="display text-[1.9rem]">
          Delivery
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-6">
          <Field className="sm:col-span-6" label="Full name" name="name" autoComplete="name" value={value.name} error={errors["address.name"]} onChange={set("name")} onBlur={onBlur} />
          <Field className="sm:col-span-4" label="Street address" name="line1" autoComplete="address-line1" value={value.line1} error={errors["address.line1"]} onChange={set("line1")} onBlur={onBlur} />
          <Field className="sm:col-span-2" label="Flat or floor" name="line2" autoComplete="address-line2" optional value={value.line2} error={errors["address.line2"]} onChange={set("line2")} onBlur={onBlur} />
          <Field className="sm:col-span-3" label="City" name="city" autoComplete="address-level2" value={value.city} error={errors["address.city"]} onChange={set("city")} onBlur={onBlur} />
          <Field className="sm:col-span-3" label="Postcode" name="postalCode" autoComplete="postal-code" value={value.postalCode} error={errors["address.postalCode"]} onChange={set("postalCode")} onBlur={onBlur} />
          <div className="sm:col-span-6">
            <label htmlFor={countryId} className="label">
              Country
            </label>
            <select
              id={countryId}
              name="country"
              className="field"
              autoComplete="country-name"
              value={value.country}
              onChange={(e) => set("country")(e.target.value)}
              aria-invalid={errors["address.country"] ? true : undefined}
            >
              {COUNTRIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
      </section>
    </>
  );
}
