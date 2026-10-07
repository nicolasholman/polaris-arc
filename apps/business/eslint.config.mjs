import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Server code must never read the merchant from a header; the auth check
      // script enforces the wrapper, this catches the header by name.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^x-wallet-address$/i]",
          message: "Never trust a wallet address sent by the client. Use withMerchant() from @/server/auth.",
        },
      ],
    },
  },
  {
    // Tests read JSON responses; typing every one of them adds nothing.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", ".data/**"],
  },
];

export default config;
