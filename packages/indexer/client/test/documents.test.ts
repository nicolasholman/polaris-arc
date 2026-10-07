/**
 * Every document the client sends is valid against the indexer's schema (as
 * Envio's Hasura exposes it), and the decoder turns every BigInt column a
 * document selects into a bigint.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Kind, parse, validate, type FieldDefinitionNode, type ObjectTypeDefinitionNode, type TypeNode } from "graphql";

import { BIGINT_FIELDS } from "../src/decode.js";
import { DOCUMENTS } from "../src/documents.js";
import { hasuraSchema } from "./hasura.js";

const SDL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema.graphql"), "utf8");
const schema = hasuraSchema(SDL);

const named = (t: TypeNode): string => (t.kind === Kind.NAMED_TYPE ? t.name.value : named(t.type));

describe("GraphQL documents", () => {
  for (const [name, source] of Object.entries(DOCUMENTS)) {
    it(`${name} is valid against the indexer schema`, () => {
      const errors = validate(schema, parse(source));
      assert.deepEqual(errors.map((e) => e.message), []);
    });
  }

  it("answers CRE in the shape the collections workflow reads, on the dunning-aware schedule", () => {
    // polaris-collections parses data.Loan[].loanId and data.Subscription[].subId.
    assert.match(DOCUMENTS.DUE_CANDIDATES, /Loan: Plan\(/);
    assert.match(DOCUMENTS.DUE_CANDIDATES, /\{ loanId liquidatableAt \}/);
    assert.match(DOCUMENTS.DUE_CANDIDATES, /Subscription\(/);
    assert.match(DOCUMENTS.DUE_CANDIDATES, /\{ subId \}/);
    assert.equal(DOCUMENTS.DUE_CANDIDATES.match(/nextAttemptAt: \{ _lte: \$now \}/g)?.length, 2);
  });
});

describe("BigInt decoding", () => {
  const entities = parse(SDL).definitions.filter((d): d is ObjectTypeDefinitionNode => d.kind === Kind.OBJECT_TYPE_DEFINITION);
  const bigintColumns = new Map(
    entities.map((e) => [
      e.name.value,
      new Set(((e.fields ?? []) as FieldDefinitionNode[]).filter((f) => named(f.type) === "BigInt").map((f) => f.name.value)),
    ]),
  );

  it("lists every BigInt column a fragment selects, and nothing else", () => {
    const documents = Object.values(DOCUMENTS).join("\n");
    for (const [entity, fields] of Object.entries(BIGINT_FIELDS)) {
      const columns = bigintColumns.get(entity);
      assert.ok(columns, `${entity} is not in schema.graphql`);
      for (const f of fields) assert.ok(columns.has(f), `${entity}.${f} is not a BigInt column`);
      const fragment = new RegExp(`fragment \\w+ on ${entity} \\{([^}]*)\\}`).exec(documents);
      if (!fragment) continue;
      const selected = new Set(fragment[1]!.split(/\s+/).filter(Boolean));
      for (const c of columns) {
        if (selected.has(c)) assert.ok((fields as readonly string[]).includes(c), `${entity}.${c} is selected but not decoded as a bigint`);
      }
    }
  });
});
