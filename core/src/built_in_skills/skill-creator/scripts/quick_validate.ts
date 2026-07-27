#!/usr/bin/env npx tsx
/**
 * Quick validation script for skills - minimal version.
 *
 * For deepagents CLI, skills are located at:
 * ~/.deepagents/<agent>/skills/<skill-name>/
 *
 * Usage:
 *   npx tsx quick_validate.ts <skill_directory>
 *
 * Example:
 *   npx tsx quick_validate.ts ~/.deepagents/agent/skills/my-skill
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Simple YAML frontmatter parser (no external dependencies).
// =============================================================================

function parseSimpleYaml(yaml: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// =============================================================================
// Validation
// =============================================================================

const ALLOWED_PROPERTIES = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "allowed-tools",
  "metadata",
]);

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

function validateSkillName(name: string, strict = true): string | null {
  if (!name || !name.trim()) return "cannot be empty";
  if (name.length > MAX_NAME_LENGTH) return `too long (${name.length} chars, max ${MAX_NAME_LENGTH})`;
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return "cannot start/end with hyphen or contain consecutive hyphens";
  }
  for (const c of name) {
    if (c === "-") continue;
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) continue;
    if (!strict && c === c.toUpperCase() && c !== c.toLowerCase()) continue; // Allow uppercase in non-strict mode
    return "must be lowercase alphanumeric with hyphens only";
  }
  return null;
}

interface ValidationResult {
  valid: boolean;
  message: string;
}

function validateSkill(skillPath: string): ValidationResult {
  const resolvedPath = resolve(skillPath.replace(/^~/, homedir()));

  // Check SKILL.md exists
  const skillMd = `${resolvedPath}/SKILL.md`;
  if (!existsSync(skillMd)) {
    return { valid: false, message: "SKILL.md not found" };
  }

  let content: string;
  try {
    content = readFileSync(skillMd, "utf-8");
  } catch (e) {
    return { valid: false, message: `Cannot read SKILL.md: ${e}` };
  }

  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" };
  }

  // Extract frontmatter
  const match = content.match(/^---\n(.*?)\n---/s);
  if (!match) {
    return { valid: false, message: "Invalid frontmatter format" };
  }

  const frontmatter = parseSimpleYaml(match[1]);
  if (!frontmatter) {
    return { valid: false, message: "Frontmatter must be a YAML dictionary" };
  }

  // Check for unexpected properties
  const unexpectedKeys = Object.keys(frontmatter).filter((k) => !ALLOWED_PROPERTIES.has(k));
  if (unexpectedKeys.length > 0) {
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys.join(", ")}. ` +
        `Allowed properties are: ${[...ALLOWED_PROPERTIES].join(", ")}`,
    };
  }

  // Check required fields
  if (!frontmatter["name"]) {
    return { valid: false, message: "Missing 'name' in frontmatter" };
  }
  if (!frontmatter["description"]) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  // Validate name
  const name = String(frontmatter["name"]).trim();
  const nameError = validateSkillName(name);
  if (nameError) {
    return { valid: false, message: `Invalid name '${name}': ${nameError}` };
  }

  // Validate description
  const description = String(frontmatter["description"]).trim();
  if (description.includes("<") || description.includes(">")) {
    return { valid: false, message: "Description cannot contain angle brackets (< or >)" };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      message: `Description too long (${description.length} chars, max ${MAX_DESCRIPTION_LENGTH})`,
    };
  }

  // Validate compatibility (if present)
  const compatibility = frontmatter["compatibility"];
  if (typeof compatibility === "string" && compatibility.trim().length > MAX_COMPATIBILITY_LENGTH) {
    return {
      valid: false,
      message: `Compatibility too long (${compatibility.trim().length} chars, max ${MAX_COMPATIBILITY_LENGTH})`,
    };
  }

  return { valid: true, message: "Skill is valid!" };
}

// =============================================================================
// Main
// =============================================================================

function main(): void {
  const args = process.argv.slice(2);

  if (args.length !== 1) {
    console.error("Usage: npx tsx quick_validate.ts <skill_directory>");
    console.error("\nExample:");
    console.error(" npx tsx quick_validate.ts ~/.deepagents/agent/skills/my-skill");
    process.exit(1);
  }

  const { valid, message } = validateSkill(args[0]);
  console.log(message);
  process.exit(valid ? 0 : 1);
}

main();
