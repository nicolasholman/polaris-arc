/**
 * The repo-root .env, for keys the scripts create themselves.
 *
 * A key is generated only when it is missing, appended to .env, and never
 * printed. Before writing, the file must be git-ignored (`git check-ignore`),
 * so a key can never be committed by accident.
 */

"use strict";

const { existsSync, readFileSync, appendFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");
const { Wallet } = require("ethers");

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const ENV_FILE = join(REPO_ROOT, ".env");

function isGitIgnored(file) {
  try {
    execFileSync("git", ["check-ignore", "-q", file], { cwd: REPO_ROOT, stdio: "ignore" });
    return true; // exit 0: ignored
  } catch {
    return false; // exit 1: not ignored (or not a repo)
  }
}

function readEnvValue(name) {
  if (process.env[name]) return process.env[name];
  if (!existsSync(ENV_FILE)) return undefined;
  const line = readFileSync(ENV_FILE, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : undefined;
}

/**
 * Return the private key in `name`, creating it in .env if missing.
 * Returns the key; callers print only its address.
 */
function ensureEnvKey(name, comment) {
  const existing = readEnvValue(name);
  if (existing) return existing;
  if (!isGitIgnored(ENV_FILE)) {
    throw new Error(`${ENV_FILE} is not git-ignored; refusing to write a private key into it.`);
  }
  const key = Wallet.createRandom().privateKey;
  const needsNewline = existsSync(ENV_FILE) && !readFileSync(ENV_FILE, "utf8").endsWith("\n");
  appendFileSync(ENV_FILE, `${needsNewline ? "\n" : ""}# ${comment}. Generated ${new Date().toISOString()}.\n${name}=${key}\n`);
  process.env[name] = key;
  return key;
}

module.exports = { REPO_ROOT, ENV_FILE, isGitIgnored, readEnvValue, ensureEnvKey };
