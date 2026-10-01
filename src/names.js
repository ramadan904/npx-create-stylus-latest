// Project names double as Cargo package names, so keep them to what Cargo accepts.
const RESERVED = new Set([
  "test", "core", "std", "alloc", "proc_macro", "self", "super", "crate",
  "stylus-sdk", "stylus_sdk", "alloy-primitives", "alloy_primitives",
]);

export function validateName(name) {
  if (!name) return "Project name is required";
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    return "Use lowercase letters, digits, '-' or '_', starting with a letter";
  }
  if (name.length > 64) return "Name must be 64 characters or fewer";
  if (RESERVED.has(name)) return `"${name}" is reserved; pick another name`;
  return null;
}

export function toCrateName(name) {
  return name.replaceAll("-", "_");
}
