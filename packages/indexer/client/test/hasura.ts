/**
 * A Hasura-shaped GraphQL schema built from the indexer's schema.graphql,
 * the way envio 3.12.1 sets Hasura up (src/Hasura.res): every entity table
 * tracked under the entity's name, so one root field per entity with where /
 * order_by / limit / offset and `<Entity>_bool_exp` / `<Entity>_order_by`
 * inputs; BigInt as `numeric`; each relation as an object relationship named
 * after the field plus its `<field>_id` column; each @derivedFrom as an array
 * relationship; and the `_meta` status view. Good enough to catch a misspelt
 * field, a wrong variable type or a missing fragment before a document ever
 * reaches the indexer; the live endpoint remains the final word (README).
 */

import { buildSchema, Kind, parse, type FieldDefinitionNode, type GraphQLSchema, type ObjectTypeDefinitionNode, type TypeNode } from "graphql";

const SCALARS: Record<string, string> = {
  ID: "String",
  String: "String",
  Int: "Int",
  Float: "float8",
  Boolean: "Boolean",
  BigInt: "numeric",
  BigDecimal: "numeric",
  Bytes: "String",
  Timestamp: "timestamptz",
  Json: "jsonb",
};

function named(t: TypeNode): string {
  return t.kind === Kind.NAMED_TYPE ? t.name.value : named(t.type);
}
const isList = (t: TypeNode): boolean => (t.kind === Kind.NON_NULL_TYPE ? isList(t.type) : t.kind === Kind.LIST_TYPE);
const isNonNull = (t: TypeNode) => t.kind === Kind.NON_NULL_TYPE;

export function hasuraSchema(sdl: string): GraphQLSchema {
  const doc = parse(sdl);
  const entities = doc.definitions.filter((d): d is ObjectTypeDefinitionNode => d.kind === Kind.OBJECT_TYPE_DEFINITION);
  const names = new Set(entities.map((e) => e.name.value));
  const out: string[] = [];

  out.push("scalar numeric", "scalar float8", "scalar timestamptz", "scalar jsonb");
  out.push("enum order_by { asc asc_nulls_first asc_nulls_last desc desc_nulls_first desc_nulls_last }");
  for (const s of ["String", "Int", "Boolean", "numeric", "float8", "timestamptz", "jsonb"]) {
    const extra = s === "String" ? " _like: String _ilike: String _nlike: String _nilike: String _regex: String" : "";
    out.push(
      `input ${s}_comparison_exp { _eq: ${s} _neq: ${s} _gt: ${s} _gte: ${s} _lt: ${s} _lte: ${s} _in: [${s}!] _nin: [${s}!] _is_null: Boolean${extra} }`,
    );
  }

  const listArgs = (t: string) => `(where: ${t}_bool_exp, order_by: [${t}_order_by!], limit: Int, offset: Int)`;
  const roots: string[] = [];

  for (const e of entities) {
    const t = e.name.value;
    const fields: string[] = ["chainId: Int!"];
    const bool: string[] = [`_and: [${t}_bool_exp!]`, `_or: [${t}_bool_exp!]`, `_not: ${t}_bool_exp`, "chainId: Int_comparison_exp"];
    const order: string[] = ["chainId: order_by"];
    for (const f of (e.fields ?? []) as FieldDefinitionNode[]) {
      const name = f.name.value;
      const base = named(f.type);
      const derived = f.directives?.some((d) => d.name.value === "derivedFrom");
      if (names.has(base)) {
        if (derived || isList(f.type)) {
          fields.push(`${name}${listArgs(base)}: [${base}!]!`);
          bool.push(`${name}: ${base}_bool_exp`);
        } else {
          fields.push(`${name}: ${base}${isNonNull(f.type) ? "!" : ""}`, `${name}_id: String${isNonNull(f.type) ? "!" : ""}`);
          bool.push(`${name}: ${base}_bool_exp`, `${name}_id: String_comparison_exp`);
          order.push(`${name}: ${base}_order_by`, `${name}_id: order_by`);
        }
        continue;
      }
      const scalar = SCALARS[base];
      if (!scalar) throw new Error(`${t}.${name}: unknown type ${base}`);
      fields.push(`${name}: ${scalar}${isNonNull(f.type) ? "!" : ""}`);
      bool.push(`${name}: ${scalar}_comparison_exp`);
      order.push(`${name}: order_by`);
    }
    out.push(`type ${t} { ${fields.join(" ")} }`);
    out.push(`input ${t}_bool_exp { ${bool.join(" ")} }`);
    out.push(`input ${t}_order_by { ${order.join(" ")} }`);
    roots.push(`${t}${listArgs(t)}: [${t}!]!`, `${t}_by_pk(id: String!, chainId: Int!): ${t}`);
  }

  // Envio's indexing status: the `_meta` view (envio 3.12.1, src/db/InternalTable.res).
  out.push(
    "scalar float4",
    "type _meta { chainId: Int! ecosystem: String startBlock: Int endBlock: Int progressBlock: Int! progressBlockTime: timestamptz bufferBlock: Int firstEventBlock: Int eventsProcessed: float4 sourceBlock: Int readyAt: timestamptz isReady: Boolean! }",
    "input _meta_bool_exp { chainId: Int_comparison_exp }",
  );
  roots.push("_meta(where: _meta_bool_exp): [_meta!]!");
  out.push(`type query_root { ${roots.join(" ")} }`, "schema { query: query_root }");
  return buildSchema(out.join("\n"));
}
